// Configuración de Socket.IO: comparte la sesión Express, valida que el
// alumno esté autorizado a entrar a la sesión, y hace el ruteo de eventos
// al Mundo correspondiente.

import type { Server as SocketIOServer } from 'socket.io';
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sesiones, participaciones, users } from '../db/schema.js';
import { registry, roomDeSesion } from '../simulacion/registry.js';
import {
  CANALES_VHF,
  type ShipControlPayload,
  type VHFTransmitPayload,
  type NavtexSendPayload,
  type DmSendPayload,
  type MensajeVHF,
  type MensajeNavtex,
  type MensajePrivado,
  type CanalVHF,
} from '../../shared/types.js';

// Contexto que cada conexión socket tiene asociado tras autenticar.
interface SocketCtx {
  userId: number;
  role: 'admin' | 'profesor' | 'alumno';
  sesionId: number;
  ownshipIndex?: number; // sólo para alumnos
  nombre: string;
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
      const auth = socket.handshake.auth as { sesionId?: number };
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
    }

    // Eventos del cliente
    socket.on('ship:control', (payload: ShipControlPayload) => {
      if (ctx.role !== 'alumno' || ctx.ownshipIndex === undefined) return;
      const mundo = registry.obtener(ctx.sesionId);
      if (!mundo) return;
      if (typeof payload.telegrafo === 'string') {
        mundo.setTelegrafo(ctx.ownshipIndex, payload.telegrafo);
      }
      if (typeof payload.rudderCommandDeg === 'number' && Number.isFinite(payload.rudderCommandDeg)) {
        mundo.setRudderCommand(ctx.ownshipIndex, payload.rudderCommandDeg);
      }
      if (typeof payload.setCourseDeg === 'number' && Number.isFinite(payload.setCourseDeg)) {
        mundo.setSetCourse(ctx.ownshipIndex, payload.setCourseDeg);
      }
      if (typeof payload.autopilotOn === 'boolean') {
        mundo.setAutopilot(ctx.ownshipIndex, payload.autopilotOn);
      }
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

    socket.on('disconnect', () => {
      // No-op; el alumno puede reconectarse y el Mundo sigue vivo en el server.
    });
  });
}
