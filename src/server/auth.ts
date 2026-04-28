import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import type { PublicUser, Role } from '../shared/types.js';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function findUserByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return rows[0] ?? null;
}

export async function findUserById(id: number) {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export function toPublicUser(u: { id: number; email: string; nombre: string; role: string }): PublicUser {
  return {
    id: u.id,
    email: u.email,
    nombre: u.nombre,
    role: u.role as Role,
  };
}

declare module 'express-session' {
  interface SessionData {
    userId?: number;
  }
}
