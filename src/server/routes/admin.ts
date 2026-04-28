import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword, toPublicUser } from '../auth.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { ROLES } from '../../shared/types.js';

export const adminRouter: Router = Router();

adminRouter.use(requireAuth, requireRole('admin'));

const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  nombre: z.string().min(1).max(255),
  role: z.enum(ROLES),
});

adminRouter.get('/users', async (req, res) => {
  const roleFilter = typeof req.query.role === 'string' ? req.query.role : null;
  const rows = roleFilter && (ROLES as readonly string[]).includes(roleFilter)
    ? await db.select().from(users).where(eq(users.role, roleFilter)).orderBy(users.nombre)
    : await db.select().from(users).orderBy(users.id);
  res.json({ users: rows.map(toPublicUser) });
});

adminRouter.post('/users', async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
    return;
  }
  const { email, password, nombre, role } = parsed.data;
  const passwordHash = await hashPassword(password);
  try {
    const [created] = await db
      .insert(users)
      .values({ email: email.toLowerCase(), passwordHash, nombre, role })
      .returning();
    if (!created) {
      res.status(500).json({ error: 'No se pudo crear el usuario' });
      return;
    }
    res.status(201).json({ user: toPublicUser(created) });
  } catch (err: unknown) {
    // Postgres unique violation
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      res.status(409).json({ error: 'Ya existe un usuario con ese email' });
      return;
    }
    throw err;
  }
});
