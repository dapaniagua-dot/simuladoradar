import 'dotenv/config';
import crypto from 'node:crypto';
import { db } from '../src/server/db/index.js';
import { users, escenarios } from '../src/server/db/schema.js';
import { hashPassword } from '../src/server/auth.js';
import { eq } from 'drizzle-orm';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@enf.local';
const ADMIN_NOMBRE = process.env.ADMIN_NOMBRE ?? 'Administrador';

async function main(): Promise<void> {
  await seedAdmin();
  await seedEscenarios();
  process.exit(0);
}

async function seedAdmin(): Promise<void> {
  const existing = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL)).limit(1);
  if (existing.length > 0) {
    console.log(`[admin] Ya existe ${ADMIN_EMAIL}, no se toca.`);
    return;
  }
  const tempPassword = process.env.ADMIN_PASSWORD ?? crypto.randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(tempPassword);
  await db.insert(users).values({
    email: ADMIN_EMAIL,
    passwordHash,
    nombre: ADMIN_NOMBRE,
    role: 'admin',
  });
  console.log('=== Usuario admin creado ===');
  console.log(`Email:      ${ADMIN_EMAIL}`);
  console.log(`Contraseña: ${tempPassword}`);
  console.log('============================');
  console.log('Guardá la contraseña ahora — no se va a mostrar de nuevo.');
}

async function seedEscenarios(): Promise<void> {
  // Catálogo inicial de cartas náuticas. Cada slug debe tener una carpeta
  // /public/cartas/<slug>/ con carta.png + carta.map.
  const catalogo = [
    {
      slug: 'mar-del-plata',
      nombre: 'H-250 Rada Mar del Plata',
      descripcion: 'Carta náutica de la Rada de Mar del Plata. Original del simulador Melipal/INVAP.',
    },
  ];
  for (const item of catalogo) {
    const existing = await db.select().from(escenarios).where(eq(escenarios.slug, item.slug)).limit(1);
    if (existing.length > 0) {
      console.log(`[escenario] Ya existe '${item.slug}', no se toca.`);
      continue;
    }
    await db.insert(escenarios).values(item);
    console.log(`[escenario] Sembrado: ${item.slug} (${item.nombre})`);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
