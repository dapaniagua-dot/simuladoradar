import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { escenarios } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { parseMapFile } from '../cartas/mapParser.js';

export const escenariosRouter: Router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resuelve la carpeta /public/cartas tanto en dev (compilando desde src/server/...)
// como en runtime (corriendo desde dist/server/...).
function publicCartasDir(): string {
  // En runtime el __dirname es /app/dist/server/routes
  // En dev (tsx) es .../src/server/routes
  // /public/cartas vive en la raíz del proyecto, no se mueve con el build.
  // Buscamos hacia arriba hasta encontrar la carpeta public.
  const candidatos = [
    path.resolve(__dirname, '../../../public/cartas'),
    path.resolve(__dirname, '../../public/cartas'),
    path.resolve(process.cwd(), 'public/cartas'),
  ];
  return candidatos[0]!; // El primer candidato funciona tanto en src/ como en dist/
}

// Solo profesores y admins ven el catálogo. Los alumnos ven cartas a través
// de la sesión a la que están asignados (cuando el modelo de sesiones lo permita).
escenariosRouter.use(requireAuth);

escenariosRouter.get('/', requireRole('profesor', 'admin'), async (_req, res) => {
  const rows = await db.select().from(escenarios).orderBy(escenarios.nombre);
  res.json({ escenarios: rows });
});

escenariosRouter.get('/:id', requireRole('profesor', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const rows = await db.select().from(escenarios).where(eq(escenarios.id, id)).limit(1);
  const esc = rows[0];
  if (!esc) {
    res.status(404).json({ error: 'Escenario no encontrado' });
    return;
  }
  // Parsear el .map en disco y devolver la geometría más la URL del raster.
  const cartasDir = publicCartasDir();
  const mapPath = path.join(cartasDir, esc.slug, 'carta.map');
  const rasterUrl = `/cartas/${esc.slug}/carta.png`;
  try {
    await fs.access(mapPath);
  } catch {
    res.status(500).json({ error: `Archivo de carta no encontrado: ${esc.slug}/carta.map` });
    return;
  }
  const carta = await parseMapFile(mapPath, rasterUrl);
  res.json({ escenario: esc, carta });
});
