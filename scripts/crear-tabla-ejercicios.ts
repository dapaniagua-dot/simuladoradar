// Crea la tabla "ejercicios" (ver src/server/db/schema.ts). Se usa en lugar de
// `drizzle-kit push` para no arriesgar cambios en las otras tablas de la base
// de producción. Es idempotente: se puede correr más de una vez.
//   npx tsx scripts/crear-tabla-ejercicios.ts
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/server/db/index.js';

await db.execute(sql`
  CREATE TABLE IF NOT EXISTS ejercicios (
    id serial PRIMARY KEY,
    profesor_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    escenario_id integer NOT NULL REFERENCES escenarios(id) ON DELETE RESTRICT,
    nombre varchar(255) NOT NULL,
    descripcion text,
    datos jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`);
await db.execute(sql`
  CREATE INDEX IF NOT EXISTS ejercicios_profesor_escenario_idx ON ejercicios (profesor_id, escenario_id)
`);
console.log('Tabla "ejercicios" lista.');
process.exit(0);
