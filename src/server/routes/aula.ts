import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sesiones, escenarios, participaciones } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { parseMapFile } from '../cartas/mapParser.js';

export const aulaRouter: Router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

aulaRouter.use(requireAuth);

// Endpoint que usa el alumno cuando entra a la sesión. Hace los tres checks
// de autorización en una sola query:
//   1) la sesión existe
//   2) el alumno está asignado a esa sesión
//   3) la sesión está en estado 'abierta'
// Si todo pasa, devuelve la carta parseada + datos de la sesión + ownshipIndex.
aulaRouter.get('/:sesionId', requireRole('alumno'), async (req, res) => {
  const sesionId = Number(req.params.sesionId);
  if (!Number.isFinite(sesionId)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const me = req.user!;

  const rows = await db
    .select({
      sesionId: sesiones.id,
      sesionNombre: sesiones.nombre,
      sesionDescripcion: sesiones.descripcion,
      sesionEstado: sesiones.estado,
      ownshipIndex: participaciones.ownshipIndex,
      escenarioId: escenarios.id,
      escenarioNombre: escenarios.nombre,
      escenarioSlug: escenarios.slug,
    })
    .from(participaciones)
    .innerJoin(sesiones, eq(participaciones.sesionId, sesiones.id))
    .innerJoin(escenarios, eq(sesiones.escenarioId, escenarios.id))
    .where(and(eq(participaciones.alumnoId, me.id), eq(participaciones.sesionId, sesionId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: 'No estás asignado a esta sesión' });
    return;
  }
  if (row.sesionEstado !== 'abierta') {
    res
      .status(403)
      .json({ error: `La sesión está en estado '${row.sesionEstado}', no abierta` });
    return;
  }

  // Cargamos la carta (mismo parser que usa el profesor).
  const cartasDir = path.resolve(__dirname, '../../../public/cartas');
  const mapPath = path.join(cartasDir, row.escenarioSlug, 'carta.map');
  const rasterUrl = `/cartas/${row.escenarioSlug}/carta.png`;
  try {
    await fs.access(mapPath);
  } catch {
    res.status(500).json({ error: `Archivo de carta no encontrado: ${row.escenarioSlug}/carta.map` });
    return;
  }
  const carta = await parseMapFile(mapPath, rasterUrl);

  res.json({
    sesion: {
      id: row.sesionId,
      nombre: row.sesionNombre,
      descripcion: row.sesionDescripcion,
      escenarioNombre: row.escenarioNombre,
      ownshipIndex: row.ownshipIndex,
    },
    carta,
  });
});
