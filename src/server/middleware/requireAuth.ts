import type { Request, Response, NextFunction } from 'express';
import { findUserById, toPublicUser } from '../auth.js';
import type { PublicUser, Role } from '../../shared/types.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: PublicUser;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }
  const user = await findUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Sesión inválida' });
    return;
  }
  req.user = toPublicUser(user);
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'No autorizado' });
      return;
    }
    next();
  };
}
