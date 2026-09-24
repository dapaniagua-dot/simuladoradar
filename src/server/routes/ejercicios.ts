// Ejercicios guardados ("guardar / abrir ejercicio" del Melipal). Cada
// profesor guarda sus situaciones armadas (posición de los buques propios y
// blancos) asociadas a una carta, para cargarlas en otras clases.

import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { ejercicios, type DbEjercicio } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import type { DatosEjercicio, EjercicioResumen } from '../../shared/types.js';

export const ejerciciosRouter: Router = Router();
ejerciciosRouter.use(requireAuth, requireRole('profesor', 'admin'));

const coord = z.number().finite();
const waypointSchema = z.object({ lat: coord, lon: coord, velKn: z.number().finite().min(0).max(40) });

// También lo usa el socket al cargar un ejercicio en una sesión en curso.
export const datosEjercicioSchema = z.object({
  version: z.literal(1),
  buques: z.array(z.object({
    ownshipIndex: z.number().int().min(1).max(20),
    lat: coord,
    lon: coord,
    headingDeg: z.number().finite(),
  })).max(20),
  blancos: z.array(z.object({
    tipo: z.enum(['DT', 'T']),
    lat: coord,
    lon: coord,
    rumbo: z.number().finite(),
    velKn: z.number().finite().min(0).max(40),
    waypoints: z.array(waypointSchema).max(50).optional(),
  })).max(50),
});

const guardarSchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  descripcion: z.string().trim().max(2000).optional().nullable(),
  escenarioId: z.number().int().positive(),
  datos: datosEjercicioSchema,
});

function resumen(e: DbEjercicio): EjercicioResumen {
  return {
    id: e.id,
    nombre: e.nombre,
    descripcion: e.descripcion,
    escenarioId: e.escenarioId,
    cantBuques: e.datos.buques.length,
    cantBlancos: e.datos.blancos.length,
    updatedAt: e.updatedAt.toISOString(),
  };
}

// Solo el dueño (o un admin) ve y modifica un ejercicio.
async function buscarPropio(id: number, user: { id: number; role: string }): Promise<DbEjercicio | null> {
  const rows = await db.select().from(ejercicios).where(eq(ejercicios.id, id)).limit(1);
  const e = rows[0];
  if (!e) return null;
  return user.role === 'admin' || e.profesorId === user.id ? e : null;
}

// Lista de los ejercicios del profesor para una carta.
ejerciciosRouter.get('/', async (req, res) => {
  const escenarioId = Number(req.query.escenarioId);
  if (!Number.isInteger(escenarioId) || escenarioId <= 0) {
    res.status(400).json({ error: 'Falta escenarioId' });
    return;
  }
  const me = req.user!;
  const filtro = me.role === 'admin'
    ? eq(ejercicios.escenarioId, escenarioId)
    : and(eq(ejercicios.escenarioId, escenarioId), eq(ejercicios.profesorId, me.id));
  const rows = await db.select().from(ejercicios).where(filtro).orderBy(desc(ejercicios.updatedAt));
  res.json({ ejercicios: rows.map(resumen) });
});

ejerciciosRouter.get('/:id', async (req, res) => {
  const e = await buscarPropio(Number(req.params.id), req.user!);
  if (!e) {
    res.status(404).json({ error: 'Ejercicio no encontrado' });
    return;
  }
  res.json({ ejercicio: { ...resumen(e), datos: e.datos satisfies DatosEjercicio } });
});

ejerciciosRouter.post('/', async (req, res) => {
  const parsed = guardarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos del ejercicio inválidos' });
    return;
  }
  const { nombre, descripcion, escenarioId, datos } = parsed.data;
  const [creado] = await db.insert(ejercicios).values({
    profesorId: req.user!.id, escenarioId, nombre, descripcion: descripcion ?? null, datos,
  }).returning();
  res.status(201).json({ ejercicio: resumen(creado!) });
});

// Sobrescribir un ejercicio existente (guardar con el mismo nombre).
ejerciciosRouter.put('/:id', async (req, res) => {
  const e = await buscarPropio(Number(req.params.id), req.user!);
  if (!e) {
    res.status(404).json({ error: 'Ejercicio no encontrado' });
    return;
  }
  const parsed = guardarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos del ejercicio inválidos' });
    return;
  }
  const { nombre, descripcion, datos } = parsed.data;
  const [actualizado] = await db.update(ejercicios)
    .set({ nombre, descripcion: descripcion ?? null, datos, updatedAt: new Date() })
    .where(eq(ejercicios.id, e.id))
    .returning();
  res.json({ ejercicio: resumen(actualizado!) });
});

ejerciciosRouter.delete('/:id', async (req, res) => {
  const e = await buscarPropio(Number(req.params.id), req.user!);
  if (!e) {
    res.status(404).json({ error: 'Ejercicio no encontrado' });
    return;
  }
  await db.delete(ejercicios).where(eq(ejercicios.id, e.id));
  res.json({ ok: true });
});
