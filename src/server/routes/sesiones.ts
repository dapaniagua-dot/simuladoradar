import { Router } from 'express';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sesiones, escenarios } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import type { Sesion } from '../../shared/types.js';

export const sesionesRouter: Router = Router();

sesionesRouter.use(requireAuth);

const createSesionSchema = z.object({
  nombre: z.string().min(1).max(255),
  descripcion: z.string().max(2000).optional(),
  escenarioId: z.number().int().positive(),
});

// Lista las sesiones del profesor logueado, más reciente primero.
// Admin ve todas las sesiones (las suyas y las de los demás).
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

// Crea una sesión nueva. Sólo profesores y admins.
sesionesRouter.post('/', requireRole('profesor', 'admin'), async (req, res) => {
  const parsed = createSesionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
    return;
  }
  const me = req.user!;
  // Validar que el escenario existe.
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

// Detalle de una sesión. Profesor dueño o admin.
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
