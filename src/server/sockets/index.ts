// Configuración de Socket.IO: comparte la sesión Express, valida que el
// alumno esté autorizado a entrar a la sesión, y hace el ruteo de eventos
// al Mundo correspondiente.

import type { Server as SocketIOServer } from 'socket.io';
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sesiones, participaciones, users } from '../db/schema.js';
import { registry, roomDeSesion } from '../simulacion/registry.js';
import { datosEjercicioSchema } from '../routes/ejercicios.js';
import {
  CANALES_VHF,
  TELEGRAFO_IDS,
  type ShipControlPayload,
  type TelegrafoId,
  type VHFTransmitPayload,
  type NavtexSendPayload,
  type DmSendPayload,
  type MensajeVHF,
  type MensajeNavtex,
  type MensajePrivado,
  type CanalVHF,
  type PresenciaEstado,
  type CrearBlancoPayload,
  type ModificarBlancoPayload,
  type WaypointDTO,
  type FallasBuque,
  type PresenciaEvento,
  type VistaCliente,
} from '../../shared/types.js';

// Contexto que cada conexión socket tiene asociado tras autenticar.
interface SocketCtx {
  userId: number;
  role: 'admin' | 'profesor' | 'alumno';
  sesionId: number;
  ownshipIndex?: number; // sólo para alumnos
  nombre: string;
  vista: VistaCliente;
}

// Pantallas abiertas por cada alumno, por sesión. Solo cuentan los alumnos
// (el profesor observando el radar de un alumno no lo "conecta").
const presencia = new Map<number, PresenciaEstado>();

function presenciaDe(sesionId: number): PresenciaEstado {
  let p = presencia.get(sesionId);
  if (!p) {
    p = {};
    presencia.set(sesionId, p);
  }
  return p;
}

export function setupSockets(io: SocketIOServer, sessionMiddleware: RequestHandler): void {
  registry.setSocketServer(io);

  // Reusar la sesión Express en Socket.IO (cookie HTTPOnly + connect.sid).
  // Express RequestHandler != socket.io middleware, pero engine.use lo soporta.
  io.engine.use(sessionMiddleware as never);

  io.use(async (socket, next) => {
    try {
      const req = socket.request as { session?: { userId?: number } };
      const userId = req.session?.userId;
      if (!userId) return next(new Error('No autenticado'));

      // ¿A qué sesión querés conectarte? Lo pasamos por handshake auth.
      const auth = socket.handshake.auth as { sesionId?: number; vista?: string };
      const sesionId = Number(auth.sesionId);
      if (!Number.isFinite(sesionId) || sesionId <= 0) {
        return next(new Error('Falta sesionId en el handshake'));
      }

      const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      const user = userRows[0];
      if (!user) return next(new Error('Usuario inválido'));

      // Validar acceso a la sesión:
      //  - admin / profesor dueño: acceden siempre
      //  - alumno: debe estar asignado y la sesión estar 'abierta'
      const sesionRows = await db.select().from(sesiones).where(eq(sesiones.id, sesionId)).limit(1);
      const ses = sesionRows[0];
      if (!ses) return next(new Error('Sesión no encontrada'));

      const ctx: SocketCtx = {
        userId: user.id,
        role: user.role as SocketCtx['role'],
        sesionId,
        nombre: user.nombre,
        vista: auth.vista === 'radar' || auth.vista === 'instructor' ? auth.vista : 'aula',
      };

      if (user.role === 'admin') {
        // OK
      } else if (user.role === 'profesor') {
        if (ses.profesorId !== user.id) return next(new Error('No autorizado'));
      } else if (user.role === 'alumno') {
        if (ses.estado !== 'abierta') return next(new Error("La sesión no está abierta"));
        const partRows = await db
          .select()
          .from(participaciones)
          .where(eq(participaciones.sesionId, sesionId))
          .limit(50);
        const mia = partRows.find((p) => p.alumnoId === user.id);
        if (!mia) return next(new Error('No estás asignado a esta sesión'));
        ctx.ownshipIndex = mia.ownshipIndex;
        // Defensive: si la sesión está abierta pero el Mundo no existe (p.ej.
        // tras un reinicio del server que falló al restaurarlo), lo creamos
        // ahora. Esto evita que el alumno entre a un radar vacío.
        if (!registry.obtener(sesionId)) {
          await registry.crearYArrancar(sesionId);
        }
      } else {
        return next(new Error('Rol desconocido'));
      }

      (socket.data as { ctx: SocketCtx }).ctx = ctx;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('Error de autenticación'));
    }
  });

  io.on('connection', (socket) => {
    const ctx = (socket.data as { ctx: SocketCtx }).ctx;
    const room = roomDeSesion(ctx.sesionId);
    void socket.join(room);

    // Mandar el estado actual al recién conectado, para que pinte algo
    // mientras espera el próximo tick.
    const mundo = registry.obtener(ctx.sesionId);
    if (mundo) {
      socket.emit('world:tick', mundo.estadoActual());
      // Y los mensajes recientes (VHF / Navtex / privados que le tocan)
      // para que el chat no aparezca vacío al refrescar.
      socket.emit('chat:snapshot', mundo.snapshotMensajes(ctx.userId));
      socket.emit('traza:snapshot', mundo.snapshotTrazas(ctx.role === 'alumno' ? ctx.ownshipIndex : undefined));
    }

    // Presencia: el instructor ve qué alumnos tienen abierta el aula / el radar.
    const cambiarPresencia = (delta: 1 | -1) => {
      if (ctx.role !== 'alumno' || ctx.ownshipIndex === undefined || ctx.vista === 'instructor') return;
      const p = presenciaDe(ctx.sesionId);
      const os = (p[ctx.ownshipIndex] ??= { aula: 0, radar: 0 });
      os[ctx.vista] = Math.max(0, os[ctx.vista] + delta);
      const evento: PresenciaEvento = {
        ownshipIndex: ctx.ownshipIndex, nombre: ctx.nombre, vista: ctx.vista, conectado: delta > 0, ts: Date.now(),
      };
      io.to(room).emit('presencia:estado', p);
      io.to(room).emit('presencia:evento', evento);
    };
    cambiarPresencia(1);
    if (ctx.role !== 'alumno') socket.emit('presencia:estado', presenciaDe(ctx.sesionId));

    // Eventos del cliente
    // Comandos del buque. Los manda el alumno sobre el suyo, salvo que el
    // instructor haya tomado el control ("Switch Ctrl"): ahí solo valen los
    // del profesor, que indica a qué buque van.
    socket.on('ship:control', (payload: ShipControlPayload) => {
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo) return;
      let os: number;
      if (ctx.role === 'alumno') {
        if (ctx.ownshipIndex === undefined || mundo.controlInstructor(ctx.ownshipIndex)) return;
        os = ctx.ownshipIndex;
      } else {
        if (typeof payload.ownshipIndex !== 'number' || !mundo.controlInstructor(payload.ownshipIndex)) return;
        os = payload.ownshipIndex;
      }
      // Validamos contra la lista: el payload viene del navegador.
      if (TELEGRAFO_IDS.includes(payload.telegrafoBabor as TelegrafoId)) {
        mundo.setTelegrafo(os, 'babor', payload.telegrafoBabor as TelegrafoId);
      }
      if (TELEGRAFO_IDS.includes(payload.telegrafoEstribor as TelegrafoId)) {
        mundo.setTelegrafo(os, 'estribor', payload.telegrafoEstribor as TelegrafoId);
      }
      if (typeof payload.rudderCommandDeg === 'number' && Number.isFinite(payload.rudderCommandDeg)) {
        mundo.setRudderCommand(os, payload.rudderCommandDeg);
      }
      if (typeof payload.setCourseDeg === 'number' && Number.isFinite(payload.setCourseDeg)) {
        mundo.setSetCourse(os, payload.setCourseDeg);
      }
      if (typeof payload.autopilotOn === 'boolean') {
        mundo.setAutopilot(os, payload.autopilotOn);
      }
    });

    // ===== Fallas inducidas, control y ARPA (solo instructor) =====
    socket.on('fallas:set', (p: { ownshipIndex?: unknown; fallas?: Record<string, unknown> }) => {
      if (ctx.role === 'alumno' || typeof p?.ownshipIndex !== 'number' || !p.fallas) return;
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo) return;
      const f = p.fallas;
      const cambios: Partial<FallasBuque> = {};
      for (const k of ['gps', 'giro', 'log', 'autopiloto', 'maquina', 'radar'] as const) {
        if (typeof f[k] === 'boolean') cambios[k] = f[k] as boolean;
      }
      if (typeof f.sectorCiegoDeg === 'number' && Number.isFinite(f.sectorCiegoDeg)) {
        cambios.sectorCiegoDeg = Math.max(0, Math.min(180, f.sectorCiegoDeg));
      }
      if (f.ecoFalsoDeg === null) cambios.ecoFalsoDeg = null;
      else if (typeof f.ecoFalsoDeg === 'number' && Number.isFinite(f.ecoFalsoDeg)) {
        cambios.ecoFalsoDeg = ((f.ecoFalsoDeg % 360) + 360) % 360;
      }
      mundo.setFallas(p.ownshipIndex, cambios);
    });
    socket.on('control:set', (p: { ownshipIndex?: unknown; tomar?: unknown }) => {
      if (ctx.role === 'alumno' || typeof p?.ownshipIndex !== 'number' || typeof p.tomar !== 'boolean') return;
      registry.obtener(ctx.sesionId)?.setControlInstructor(p.ownshipIndex, p.tomar);
    });
    // ===== Ejercicios guardados =====
    // Foto de la situación actual (el instructor la guarda por la API).
    socket.on('ejercicio:exportar', (_: unknown, responder?: (datos: unknown) => void) => {
      if (ctx.role === 'alumno' || typeof responder !== 'function') return;
      responder(registry.obtener(ctx.sesionId)?.exportarEjercicio() ?? null);
    });
    // Cargar un ejercicio en la sesión en curso. Los recorridos arrancan de
    // cero, así que se avisa a todos para que limpien los suyos.
    socket.on('ejercicio:cargar', (p: unknown) => {
      if (ctx.role === 'alumno') return;
      const mundo = registry.obtener(ctx.sesionId);
      const parsed = datosEjercicioSchema.safeParse(p);
      if (!mundo || !parsed.success) return;
      mundo.cargarEjercicio(parsed.data);
      io.to(room).emit('traza:reinicio');
    });

    // "Lose ARPA Targets": el radar de ese alumno suelta todos sus blancos.
    socket.on('radar:perder-arpa', (p: { ownshipIndex?: unknown }) => {
      if (ctx.role === 'alumno' || typeof p?.ownshipIndex !== 'number') return;
      io.to(room).emit('radar:perder-arpa', { ownshipIndex: p.ownshipIndex });
    });

    // ===== VHF: cualquiera transmite, todos los conectados a la sala
    // reciben (en el cliente se filtra por canal sintonizado). =====
    socket.on('vhf:transmit', (payload: VHFTransmitPayload) => {
      const texto = (payload.texto ?? '').trim();
      if (!texto || texto.length > 500) return;
      const canalNum = Number(payload.canal);
      if (!CANALES_VHF.includes(canalNum as CanalVHF)) return;
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo) return;
      const remitenteNombre = ctx.role === 'alumno'
        ? `OS-${ctx.ownshipIndex}: ${ctx.nombre}`
        : ctx.nombre;
      const mensaje: MensajeVHF = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        canal: canalNum as CanalVHF,
        remitenteUserId: ctx.userId,
        remitenteNombre,
        texto,
        ts: Date.now(),
      };
      mundo.guardarVHF(mensaje);
      io.to(roomDeSesion(ctx.sesionId)).emit('vhf:message', mensaje);
    });

    // ===== Navtex: solo profesor / admin emiten. Todos en la sala reciben. =====
    socket.on('navtex:send', (payload: NavtexSendPayload) => {
      if (ctx.role === 'alumno') return;
      const texto = (payload.texto ?? '').trim();
      if (!texto || texto.length > 1000) return;
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo) return;
      const mensaje: MensajeNavtex = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        texto,
        ts: Date.now(),
      };
      mundo.guardarNavtex(mensaje);
      io.to(roomDeSesion(ctx.sesionId)).emit('navtex:message', mensaje);
    });

    // ===== Mensaje privado: solo profesor → alumno específico de la sesión. =====
    socket.on('dm:send', async (payload: DmSendPayload) => {
      if (ctx.role === 'alumno') return;
      const texto = (payload.texto ?? '').trim();
      const para = Number(payload.paraUserId);
      if (!texto || texto.length > 500 || !Number.isFinite(para)) return;
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo) return;
      const mensaje: MensajePrivado = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        deUserId: ctx.userId,
        paraUserId: para,
        texto,
        ts: Date.now(),
      };
      mundo.guardarPrivado(mensaje);
      // A toda la sala — el cliente filtra; o más específico, sólo a sockets
      // del receptor. Por simplicidad emitimos a la sala y filtramos en cliente.
      io.to(roomDeSesion(ctx.sesionId)).emit('dm:message', mensaje);
    });

    // ===== Blancos del instructor (DT y Targets) =====
    // Solo el profesor / admin. Validamos números: el payload viene del navegador.
    socket.on('blanco:crear', (p: CrearBlancoPayload) => {
      if (ctx.role === 'alumno') return;
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo || (p?.tipo !== 'DT' && p?.tipo !== 'T')) return;
      if (![p.lat, p.lon, p.rumbo, p.velKn].every(Number.isFinite)) return;
      const waypoints = p.tipo === 'T' ? waypointsValidos(p.waypoints) : undefined;
      if (p.tipo === 'T' && (!waypoints || waypoints.length < 2)) return;
      mundo.agregarBlanco({ tipo: p.tipo, lat: p.lat, lon: p.lon, rumbo: p.rumbo, velKn: p.velKn, waypoints });
    });
    socket.on('blanco:modificar', (p: ModificarBlancoPayload) => {
      if (ctx.role === 'alumno' || typeof p?.id !== 'string') return;
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo) return;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const waypoints = p.waypoints ? waypointsValidos(p.waypoints) : undefined;
      mundo.modificarBlanco({
        id: p.id, rumbo: num(p.rumbo), velKn: num(p.velKn), lat: num(p.lat), lon: num(p.lon),
        waypoints: waypoints && waypoints.length >= 2 ? waypoints : undefined,
      });
    });
    socket.on('blanco:borrar', (p: { id?: unknown }) => {
      if (ctx.role === 'alumno' || typeof p?.id !== 'string') return;
      registry.obtener(ctx.sesionId)?.borrarBlanco(p.id);
    });

    // Configuración del radar del alumno (escala, modo, EBL/VRM, blancos ARPA).
    // Se reenvía tal cual para que el profesor, con "Show Radar", vea el radar
    // exactamente como lo tiene el alumno. No se valida el contenido: solo lo
    // usa la pantalla del observador para dibujar.
    socket.on('radar:estado', (estado: unknown) => {
      if (ctx.role !== 'alumno' || ctx.ownshipIndex === undefined) return;
      if (JSON.stringify(estado ?? null).length > 4000) return;
      io.to(room).emit('radar:estado', { ownshipIndex: ctx.ownshipIndex, estado });
    });

    socket.on('disconnect', () => {
      // El alumno puede reconectarse y el Mundo sigue vivo en el server; solo
      // actualizamos la presencia.
      cambiarPresencia(-1);
    });
  });
}

function waypointsValidos(ws: unknown): WaypointDTO[] | undefined {
  if (!Array.isArray(ws) || ws.length > 50) return undefined;
  const out: WaypointDTO[] = [];
  for (const w of ws as WaypointDTO[]) {
    if (![w?.lat, w?.lon, w?.velKn].every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
    out.push({ lat: w.lat, lon: w.lon, velKn: w.velKn });
  }
  return out;
}
