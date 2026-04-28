import { Router, type Request } from 'express';
import { z } from 'zod';
import { eq, desc, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sesiones, escenarios, participaciones, users } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { registry } from '../simulacion/registry.js';
import {
  MAX_OWNSHIPS_POR_SESION,
  type Participacion,
  type Sesion,
  type SesionDelAlumno,
} from '../../shared/types.js';

export const sesionesRouter: Router = Router();

sesionesRouter.use(requireAuth);

const createSesionSchema = z.object({
  nombre: z.string().min(1).max(255),
  descripcion: z.string().max(2000).optional(),
  escenarioId: z.number().int().positive(),
});

// =============================================================================
// Endpoints del ALUMNO (van primero porque son más específicos en el path)
// =============================================================================

// Lista las sesiones donde el alumno está asignado y que están en estado 'abierta'.
sesionesRouter.get('/mis-sesiones', requireRole('alumno'), async (req, res) => {
  const me = req.user!;
  const rows = await db
    .select({
      id: sesiones.id,
      nombre: sesiones.nombre,
      descripcion: sesiones.descripcion,
      escenarioNombre: escenarios.nombre,
      ownshipIndex: participaciones.ownshipIndex,
      openedAt: sesiones.openedAt,
    })
    .from(participaciones)
    .innerJoin(sesiones, eq(participaciones.sesionId, sesiones.id))
    .leftJoin(escenarios, eq(sesiones.escenarioId, escenarios.id))
    .where(and(eq(participaciones.alumnoId, me.id), eq(sesiones.estado, 'abierta')))
    .orderBy(desc(sesiones.openedAt));
  const dto: SesionDelAlumno[] = rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    descripcion: r.descripcion,
    escenarioNombre: r.escenarioNombre ?? '(sin nombre)',
    ownshipIndex: r.ownshipIndex,
    openedAt: r.openedAt ? r.openedAt.toISOString() : null,
  }));
  res.json({ sesiones: dto });
});

// =============================================================================
// Endpoints del PROFESOR / ADMIN
// =============================================================================

// Lista mis sesiones (todas si soy admin).
sesionesRouter.get('/', requireRole('profesor', 'admin'), async (req, res) => {
  const me = req.user!;
  const filter = me.role === 'admin' ? undefined : eq(sesiones.profesorId, me.id);
  const rows = await db
    .select({
      id: sesiones.id,
      nombre: sesiones.nombre,
      descripcion: sesiones.descripcion,
      estado: sesiones.estado,
      escenarioId: sesiones.escenarioId,
      escenarioNombre: escenarios.nombre,
      profesorId: sesiones.profesorId,
      createdAt: sesiones.createdAt,
      openedAt: sesiones.openedAt,
      closedAt: sesiones.closedAt,
    })
    .from(sesiones)
    .leftJoin(escenarios, eq(sesiones.escenarioId, escenarios.id))
    .where(filter)
    .orderBy(desc(sesiones.createdAt));
  res.json({ sesiones: rows.map(toSesionDTO) });
});

sesionesRouter.post('/', requireRole('profesor', 'admin'), async (req, res) => {
  const parsed = createSesionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
    return;
  }
  const me = req.user!;
  const escenarioRows = await db
    .select()
    .from(escenarios)
    .where(eq(escenarios.id, parsed.data.escenarioId))
    .limit(1);
  if (escenarioRows.length === 0) {
    res.status(404).json({ error: 'Escenario no encontrado' });
    return;
  }
  const [created] = await db
    .insert(sesiones)
    .values({
      profesorId: me.id,
      escenarioId: parsed.data.escenarioId,
      nombre: parsed.data.nombre,
      descripcion: parsed.data.descripcion ?? null,
      estado: 'preparada',
    })
    .returning();
  if (!created) {
    res.status(500).json({ error: 'No se pudo crear la sesión' });
    return;
  }
  res.status(201).json({ sesion: { ...created, escenarioNombre: escenarioRows[0]!.nombre } });
});

// Detalle. Profesor dueño o admin.
sesionesRouter.get('/:id', requireRole('profesor', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const me = req.user!;
  const filterByOwner = me.role === 'admin' ? undefined : eq(sesiones.profesorId, me.id);
  const rows = await db
    .select({
      id: sesiones.id,
      nombre: sesiones.nombre,
      descripcion: sesiones.descripcion,
      estado: sesiones.estado,
      escenarioId: sesiones.escenarioId,
      escenarioNombre: escenarios.nombre,
      escenarioSlug: escenarios.slug,
      profesorId: sesiones.profesorId,
      createdAt: sesiones.createdAt,
      openedAt: sesiones.openedAt,
      closedAt: sesiones.closedAt,
    })
    .from(sesiones)
    .leftJoin(escenarios, eq(sesiones.escenarioId, escenarios.id))
    .where(filterByOwner ? and(eq(sesiones.id, id), filterByOwner) : eq(sesiones.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: 'Sesión no encontrada' });
    return;
  }
  res.json({ sesion: toSesionDTO(row), escenarioSlug: row.escenarioSlug });
});

// Cambia estado a 'abierta'. Sólo si está en 'preparada'.
sesionesRouter.post('/:id/abrir', requireRole('profesor', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const ses = await loadSesionDelDueno(req, id);
  if (!ses) {
    res.status(404).json({ error: 'Sesión no encontrada' });
    return;
  }
  if (ses.estado !== 'preparada') {
    res.status(409).json({ error: `No se puede abrir desde estado '${ses.estado}'` });
    return;
  }
  await db
    .update(sesiones)
    .set({ estado: 'abierta', openedAt: new Date(), updatedAt: new Date() })
    .where(eq(sesiones.id, id));
  // Levanta el motor de simulación de esta sesión.
  await registry.crearYArrancar(id);
  res.json({ ok: true });
});

// Cambia estado a 'finalizada'. Desde 'abierta' o 'preparada'.
sesionesRouter.post('/:id/cerrar', requireRole('profesor', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const ses = await loadSesionDelDueno(req, id);
  if (!ses) {
    res.status(404).json({ error: 'Sesión no encontrada' });
    return;
  }
  if (ses.estado === 'finalizada') {
    res.status(409).json({ error: 'La sesión ya está finalizada' });
    return;
  }
  await db
    .update(sesiones)
    .set({ estado: 'finalizada', closedAt: new Date(), updatedAt: new Date() })
    .where(eq(sesiones.id, id));
  // Termina el motor de simulación y avisa a los clientes vía Socket.IO.
  registry.destruir(id);
  res.json({ ok: true });
});

// Lista los alumnos asignados a una sesión.
sesionesRouter.get('/:id/participaciones', requireRole('profesor', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const ses = await loadSesionDelDueno(req, id);
  if (!ses) {
    res.status(404).json({ error: 'Sesión no encontrada' });
    return;
  }
  const rows = await db
    .select({
      id: participaciones.id,
      sesionId: participaciones.sesionId,
      alumnoId: participaciones.alumnoId,
      alumnoEmail: users.email,
      alumnoNombre: users.nombre,
      ownshipIndex: participaciones.ownshipIndex,
      createdAt: participaciones.createdAt,
    })
    .from(participaciones)
    .innerJoin(users, eq(participaciones.alumnoId, users.id))
    .where(eq(participaciones.sesionId, id))
    .orderBy(participaciones.ownshipIndex);
  const dto: Participacion[] = rows.map((r) => ({
    id: r.id,
    sesionId: r.sesionId,
    alumnoId: r.alumnoId,
    alumnoEmail: r.alumnoEmail,
    alumnoNombre: r.alumnoNombre,
    ownshipIndex: r.ownshipIndex,
    createdAt: r.createdAt.toISOString(),
  }));
  res.json({ participaciones: dto });
});

const addParticipacionSchema = z.object({ alumnoId: z.number().int().positive() });

// Agrega un alumno a la sesión. Le asigna automáticamente el siguiente
// ownshipIndex libre (1..MAX). Falla si ya hay 5 alumnos o si el alumno
// ya está asignado.
sesionesRouter.post('/:id/participaciones', requireRole('profesor', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const parsed = addParticipacionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'alumnoId inválido' });
    return;
  }
  const ses = await loadSesionDelDueno(req, id);
  if (!ses) {
    res.status(404).json({ error: 'Sesión no encontrada' });
    return;
  }
  if (ses.estado === 'finalizada') {
    res.status(409).json({ error: 'No se pueden agregar alumnos a una sesión finalizada' });
    return;
  }
  // Validar que el usuario es alumno.
  const alumnoRows = await db.select().from(users).where(eq(users.id, parsed.data.alumnoId)).limit(1);
  const alumno = alumnoRows[0];
  if (!alumno || alumno.role !== 'alumno') {
    res.status(400).json({ error: 'El usuario no existe o no es alumno' });
    return;
  }
  // Buscar el próximo ownshipIndex libre.
  const ocupados = await db
    .select({ idx: participaciones.ownshipIndex })
    .from(participaciones)
    .where(eq(participaciones.sesionId, id));
  const ocupadosSet = new Set(ocupados.map((o) => o.idx));
  if (ocupadosSet.size >= MAX_OWNSHIPS_POR_SESION) {
    res.status(409).json({ error: `La sesión ya tiene ${MAX_OWNSHIPS_POR_SESION} alumnos (máximo)` });
    return;
  }
  let nextIdx = 1;
  while (ocupadosSet.has(nextIdx) && nextIdx <= MAX_OWNSHIPS_POR_SESION) nextIdx++;
  try {
    const [created] = await db
      .insert(participaciones)
      .values({ sesionId: id, alumnoId: alumno.id, ownshipIndex: nextIdx })
      .returning();
    res.status(201).json({
      participacion: {
        id: created!.id,
        sesionId: created!.sesionId,
        alumnoId: created!.alumnoId,
        alumnoEmail: alumno.email,
        alumnoNombre: alumno.nombre,
        ownshipIndex: created!.ownshipIndex,
        createdAt: created!.createdAt.toISOString(),
      } satisfies Participacion,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      res.status(409).json({ error: 'Este alumno ya está asignado a la sesión' });
      return;
    }
    throw err;
  }
});

// Quita una participación.
sesionesRouter.delete(
  '/:id/participaciones/:partId',
  requireRole('profesor', 'admin'),
  async (req, res) => {
    const id = Number(req.params.id);
    const partId = Number(req.params.partId);
    if (!Number.isFinite(id) || !Number.isFinite(partId)) {
      res.status(400).json({ error: 'ID inválido' });
      return;
    }
    const ses = await loadSesionDelDueno(req, id);
    if (!ses) {
      res.status(404).json({ error: 'Sesión no encontrada' });
      return;
    }
    if (ses.estado === 'finalizada') {
      res.status(409).json({ error: 'No se pueden modificar alumnos de una sesión finalizada' });
      return;
    }
    await db
      .delete(participaciones)
      .where(and(eq(participaciones.id, partId), eq(participaciones.sesionId, id)));
    res.status(204).end();
  },
);

// Lista alumnos del sistema que NO están asignados a esta sesión.
// Sirve para poblar el dropdown "Agregar alumno".
sesionesRouter.get(
  '/:id/alumnos-disponibles',
  requireRole('profesor', 'admin'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'ID inválido' });
      return;
    }
    const ses = await loadSesionDelDueno(req, id);
    if (!ses) {
      res.status(404).json({ error: 'Sesión no encontrada' });
      return;
    }
    // Subquery: IDs de alumnos ya asignados a esta sesión.
    const asignados = db
      .select({ id: participaciones.alumnoId })
      .from(participaciones)
      .where(eq(participaciones.sesionId, id));
    const rows = await db
      .select({ id: users.id, email: users.email, nombre: users.nombre })
      .from(users)
      .where(and(eq(users.role, 'alumno'), sql`${users.id} NOT IN ${asignados}`))
      .orderBy(users.nombre);
    res.json({ alumnos: rows });
  },
);

// =============================================================================
// Helpers
// =============================================================================

// Devuelve la sesión SI el usuario actual es su dueño (profesor) o es admin.
// Si no, devuelve null. Sirve para autorizar acciones de modificación.
async function loadSesionDelDueno(req: Request, id: number) {
  const me = req.user!;
  const filterByOwner = me.role === 'admin' ? undefined : eq(sesiones.profesorId, me.id);
  const rows = await db
    .select()
    .from(sesiones)
    .where(filterByOwner ? and(eq(sesiones.id, id), filterByOwner) : eq(sesiones.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function toSesionDTO(row: {
  id: number;
  nombre: string;
  descripcion: string | null;
  estado: string;
  escenarioId: number;
  escenarioNombre: string | null;
  profesorId: number;
  createdAt: Date;
  openedAt: Date | null;
  closedAt: Date | null;
}): Sesion {
  return {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion,
    estado: row.estado as Sesion['estado'],
    escenarioId: row.escenarioId,
    escenarioNombre: row.escenarioNombre ?? '(sin nombre)',
    profesorId: row.profesorId,
    createdAt: row.createdAt.toISOString(),
    openedAt: row.openedAt ? row.openedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}
