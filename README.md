# Simulador de Radar — versión web

Plataforma online para dictar cursos de simulación de radar náutico de la **Escuela Nacional Fluvial (ENF)**. Migración web del simulador **Melipal** desarrollado por INVAP (código donado a la ENF).

> 📋 Antes de tocar código nuevo, leer el [INVENTARIO.md](../INVENTARIO.md) del proyecto padre y las [decisiones técnicas](./DECISIONS.md) ya tomadas.

## Estado

**MVP 0** — skeleton: login con roles (admin / profesor / alumno), gestión básica de usuarios, base de datos. Sin lógica de simulación todavía.

## Requisitos

- **Node.js ≥ 20** (testeado con 24)
- **PostgreSQL** — opciones recomendadas, en orden de comodidad:
  1. **Neon** ([neon.tech](https://neon.tech)) — serverless gratis, sin instalar nada, copiás el `DATABASE_URL` y listo.
  2. **Railway** ([railway.app](https://railway.app)) — gratis hasta cierto uso, también te da un `DATABASE_URL`.
  3. Postgres local (Postgres.app, Docker, `scoop install postgresql`).

## Setup local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env y completar DATABASE_URL y SESSION_SECRET.
# Para generar un SESSION_SECRET aleatorio:
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# 3. Crear las tablas en la BD
npm run db:push

# 4. Crear el usuario admin inicial (imprime la contraseña por consola — anotala)
npm run seed

# 5. Levantar dev server (server + client en paralelo)
npm run dev
# Cliente:  http://localhost:5173
# Servidor: http://localhost:3000
```

Loguearse en `http://localhost:5173/login.html` con el email admin y la contraseña que imprimió `npm run seed`.

## Estructura

```
simuladoradar/
├── src/
│   ├── server/        ← Backend Node + Express + Socket.IO
│   │   ├── db/        ← Schema y conexión Drizzle ORM
│   │   ├── routes/    ← Endpoints REST (auth, admin)
│   │   ├── middleware/← Guards de autenticación
│   │   ├── auth.ts    ← Hash de contraseñas, lookup de usuarios
│   │   └── index.ts   ← Entry point
│   ├── client/        ← Frontend HTML + TS + Canvas
│   │   ├── *.html     ← Páginas (login, dashboard, admin)
│   │   ├── *.ts       ← Lógica de cada página
│   │   └── styles/    ← CSS
│   └── shared/        ← Tipos compartidos cliente/servidor
├── scripts/
│   └── seed.ts        ← Crea el admin inicial
├── DECISIONS.md       ← Decisiones técnicas y por qué
└── README.md
```

## Scripts npm

| Script | Qué hace |
|---|---|
| `npm run dev` | Levanta server (3000) + client (5173) en paralelo, con hot reload |
| `npm run db:push` | Sincroniza el schema Drizzle con la BD |
| `npm run db:studio` | Abre Drizzle Studio para inspeccionar la BD |
| `npm run seed` | Crea el admin inicial (idempotente) |
| `npm run typecheck` | Chequea tipos sin emitir |
| `npm run build` | Build de producción |
| `npm start` | Corre el build de producción |

## Despliegue (Railway)

1. Crear proyecto en Railway, conectarlo al repo de GitHub.
2. Agregar un Postgres como servicio del proyecto. Railway expone `DATABASE_URL` automáticamente.
3. Configurar `SESSION_SECRET` (Settings → Variables) con un string aleatorio.
4. Setear `NODE_ENV=production`.
5. Build command: `npm run build`. Start command: `npm start`.

## Roadmap (resumen)

- ✅ MVP 0 — Skeleton + auth
- ⏳ MVP 1 — Visualizador de cartas náuticas (parser `.map`)
- ⏳ MVP 2 — Buque propio con física `fleet.cfg`
- ⏳ MVP 3 — PPI del radar (traducción Pascal → TS)
- ⏳ MVP 4 — Multiplayer sincrónico (instructor + 5 alumnos)
- ⏳ MVP 5 — VHF + Navtex + Replay
- 📅 v2 — Vista 3D + Assessor

Detalle completo del plan: [INVENTARIO.md](../INVENTARIO.md) §9.3.

## Convenciones

- **Idioma**: español rioplatense en código de dominio (`embarcacion`, `derrota`), inglés en términos técnicos (`socket`, `render`, `auth`).
- **Comentarios**: explicar el *por qué*, no el *qué*.
- **Nada de secretos en el repo**: claves y tokens van en `.env` (gitignoreado).

## Crédito

Migración web por Diego Alejandro Paniagua (Técnico en Informática, ENF) con asistencia de Claude Code. Sistema original Melipal © INVAP.
