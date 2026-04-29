import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Server as SocketIOServer } from 'socket.io';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { escenariosRouter } from './routes/escenarios.js';
import { sesionesRouter } from './routes/sesiones.js';
import { aulaRouter } from './routes/aula.js';
import { setupSockets } from './sockets/index.js';
import { registry } from './simulacion/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV ?? 'development';

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET no está configurada en .env');
}
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL no está configurada en .env');
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: NODE_ENV === 'development' ? 'http://localhost:5173' : false, credentials: true },
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

const PgSession = connectPgSimple(session);
const sessionMiddleware = session({
  store: new PgSession({
    conString: DATABASE_URL,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8, // 8 horas
  },
});
app.use(sessionMiddleware);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/escenarios', escenariosRouter);
app.use('/api/sesiones', sesionesRouter);
app.use('/api/aula', aulaRouter);

// /public se sirve siempre (cartas náuticas y cualquier asset estático).
const publicDir = path.resolve(__dirname, '../../public');
app.use(express.static(publicDir));

if (NODE_ENV === 'production') {
  const clientDir = path.resolve(__dirname, '../client');
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'login.html'));
  });
}

setupSockets(io, sessionMiddleware);

server.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT} (${NODE_ENV})`);
  // Recuperar sesiones que estaban "abiertas" antes del último reinicio del
  // server. Sin esto, cada deploy de Railway dejaría a los alumnos con un
  // radar vacío hasta que el profesor cierre y reabra la sesión.
  registry.restaurarSesionesAbiertas().catch((err) => {
    console.error('[server] Error restaurando sesiones abiertas:', err);
  });
});
