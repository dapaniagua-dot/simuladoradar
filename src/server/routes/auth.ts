import { Router } from 'express';
import { z } from 'zod';
import { findUserByEmail, toPublicUser, verifyPassword } from '../auth.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const authRouter: Router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email o contraseña inválidos' });
    return;
  }
  const { email, password } = parsed.data;
  const user = await findUserByEmail(email);
  if (!user) {
    // Mismo error que password incorrecto: no filtrar si el email existe.
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }
  req.session.userId = user.id;
  res.json({ user: toPublicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'No se pudo cerrar sesión' });
      return;
    }
    res.clearCookie('connect.sid');
    res.status(204).end();
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
