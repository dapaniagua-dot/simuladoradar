import 'dotenv/config';
import crypto from 'node:crypto';
import { db } from '../src/server/db/index.js';
import { users } from '../src/server/db/schema.js';
import { hashPassword } from '../src/server/auth.js';
import { eq } from 'drizzle-orm';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@enf.local';
const ADMIN_NOMBRE = process.env.ADMIN_NOMBRE ?? 'Administrador';

async function main(): Promise<void> {
  const existing = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL)).limit(1);
  if (existing.length > 0) {
    console.log(`Ya existe un usuario con email ${ADMIN_EMAIL}, no se hace nada.`);
    process.exit(0);
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
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
