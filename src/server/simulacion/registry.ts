// Registry singleton de todos los Mundos vivos en el server, indexados por sesionId.
// Cuando un profesor abre una sesión, se crea el Mundo y se inician los buques
// de los alumnos asignados. Cuando cierra, se destruye.

import type { Server as SocketIOServer } from 'socket.io';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { participaciones, escenarios, sesiones } from '../db/schema.js';
import { parseMapFile } from '../cartas/mapParser.js';
import { Mundo, type PosicionInicial } from './mundo.js';
import { MODELO_DEFAULT } from './buques.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Registry {
  private mundos = new Map<number, Mundo>();
  private io: SocketIOServer | null = null;

  setSocketServer(io: SocketIOServer): void {
    this.io = io;
  }

  obtener(sesionId: number): Mundo | null {
    return this.mundos.get(sesionId) ?? null;
  }

  // Crea un Mundo para la sesión, con un buque por cada participación.
  // Las posiciones iniciales de los buques se distribuyen en el centro de la
  // carta del escenario, separados horizontalmente.
  async crearYArrancar(sesionId: number): Promise<Mundo> {
    const existing = this.mundos.get(sesionId);
    if (existing) return existing;

    if (!this.io) throw new Error('Socket.IO no inicializado en el registry');

    const sesionRows = await db
      .select({ escenarioId: sesiones.escenarioId, escenarioSlug: escenarios.slug })
      .from(sesiones)
      .innerJoin(escenarios, eq(sesiones.escenarioId, escenarios.id))
      .where(eq(sesiones.id, sesionId))
      .limit(1);
    const sesRow = sesionRows[0];
    if (!sesRow) throw new Error(`Sesión ${sesionId} no encontrada`);

    // Cargar la carta para conocer el centro y las dimensiones.
    const cartasDir = path.resolve(__dirname, '../../../public/cartas');
    const mapPath = path.join(cartasDir, sesRow.escenarioSlug, 'carta.map');
    const carta = await parseMapFile(mapPath, '');
    const centroLat = (carta.esquinaNW.lat + carta.esquinaSE.lat) / 2;
    const centroLon = (carta.esquinaNW.lon + carta.esquinaSE.lon) / 2;

    // Cargar participaciones para saber qué OwnShips inicializar.
    const parts = await db
      .select()
      .from(participaciones)
      .where(eq(participaciones.sesionId, sesionId))
      .orderBy(participaciones.ownshipIndex);

    const io = this.io;
    const mundo = new Mundo(sesionId, (payload) => {
      io.to(roomDeSesion(sesionId)).emit('world:tick', payload);
    });

    for (const p of parts) {
      const pos = posicionInicial(centroLat, centroLon, p.ownshipIndex);
      mundo.agregarBuque(p.ownshipIndex, p.alumnoId, pos, MODELO_DEFAULT);
    }
    mundo.iniciar();
    this.mundos.set(sesionId, mundo);
    return mundo;
  }

  destruir(sesionId: number): void {
    const m = this.mundos.get(sesionId);
    if (!m) return;
    m.detener();
    this.mundos.delete(sesionId);
    // Avisamos a los clientes que la sesión cerró.
    if (this.io) {
      this.io.to(roomDeSesion(sesionId)).emit('session:closed', { sesionId });
    }
  }

  // Agrega un buque al Mundo en vivo si está activo. Se usa cuando el profesor
  // asigna un alumno a una sesión que YA está abierta — sin esto, el alumno
  // nuevo no aparece hasta que el profesor cierre y reabra la sesión.
  async agregarParticipanteEnVivo(sesionId: number, alumnoId: number, ownshipIndex: number): Promise<void> {
    const mundo = this.mundos.get(sesionId);
    if (!mundo) return; // sesión no abierta — el alumno se incorporará al abrirla
    // Posición inicial: misma fórmula que al crear el Mundo.
    const sesionRows = await db
      .select({ escenarioSlug: escenarios.slug })
      .from(sesiones)
      .innerJoin(escenarios, eq(sesiones.escenarioId, escenarios.id))
      .where(eq(sesiones.id, sesionId))
      .limit(1);
    const slug = sesionRows[0]?.escenarioSlug;
    if (!slug) return;
    const cartasDir = path.resolve(__dirname, '../../../public/cartas');
    const mapPath = path.join(cartasDir, slug, 'carta.map');
    const carta = await parseMapFile(mapPath, '');
    const centroLat = (carta.esquinaNW.lat + carta.esquinaSE.lat) / 2;
    const centroLon = (carta.esquinaNW.lon + carta.esquinaSE.lon) / 2;
    const SEPARACION_GRADOS_LON = 0.0083;
    const offset = (ownshipIndex - 3) * SEPARACION_GRADOS_LON;
    mundo.agregarBuque(ownshipIndex, alumnoId, {
      lat: centroLat,
      lon: centroLon + offset,
      headingDeg: 0,
    });
  }

  // Quita un buque del Mundo si la sesión está abierta. Idempotente.
  quitarParticipanteEnVivo(sesionId: number, ownshipIndex: number): void {
    const mundo = this.mundos.get(sesionId);
    if (!mundo) return;
    mundo.quitarBuque(ownshipIndex);
  }

  // Verifica si un alumno está asignado a una sesión activa. Para autorizar
  // la conexión WebSocket sin depender de la BD en cada tick.
  async puedeAlumnoEntrar(sesionId: number, alumnoId: number): Promise<boolean> {
    const rows = await db
      .select()
      .from(participaciones)
      .where(and(eq(participaciones.sesionId, sesionId), eq(participaciones.alumnoId, alumnoId)))
      .limit(1);
    return rows.length > 0;
  }
}

export const registry = new Registry();

export function roomDeSesion(sesionId: number): string {
  return `sesion:${sesionId}`;
}

// Distribuye los buques iniciales en una línea de 5 puntos separados por
// ~0.5 millas alrededor del centro de la carta. Headings al norte (0°).
function posicionInicial(centroLat: number, centroLon: number, ownshipIndex: number): PosicionInicial {
  // Espaciado de 0.5 millas entre buques en dirección este, partiendo del centro.
  const SEPARACION_GRADOS_LON = 0.0083; // ≈ 0.5 millas a lat -38°
  const offset = (ownshipIndex - 3) * SEPARACION_GRADOS_LON; // OS-3 queda en el centro
  return {
    lat: centroLat,
    lon: centroLon + offset,
    headingDeg: 0,
  };
}
