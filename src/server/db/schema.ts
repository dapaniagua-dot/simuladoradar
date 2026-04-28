import { pgTable, serial, varchar, integer, text, timestamp, index } from 'drizzle-orm/pg-core';

// Roles del sistema. Validados también por Zod en la capa de aplicación
// (Postgres no usa enum nativo acá para simplificar las migraciones).
export const ROLES = ['admin', 'profesor', 'alumno'] as const;

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    nombre: varchar('nombre', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index('users_email_idx').on(table.email),
  }),
);

// Tabla manejada por connect-pg-simple (sesiones de express-session).
// Drizzle solo la refleja para que aparezca en migraciones; no la usamos en queries.
export const sessions = pgTable('session', {
  sid: varchar('sid').primaryKey(),
  sess: varchar('sess').notNull(),
  expire: timestamp('expire', { precision: 6 }).notNull(),
});

export type DbUser = typeof users.$inferSelect;
export type NewDbUser = typeof users.$inferInsert;

// Catálogo de cartas náuticas / escenarios disponibles para que un profesor
// arme una sesión de simulación. `slug` identifica la carpeta en /public/cartas.
export const escenarios = pgTable('escenarios', {
  id: serial('id').primaryKey(),
  nombre: varchar('nombre', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  descripcion: text('descripcion'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DbEscenario = typeof escenarios.$inferSelect;

// Estados posibles de una sesión:
//   preparada → el profesor está armando, los alumnos no entran
//   abierta   → los alumnos asignados pueden entrar y operar
//   finalizada→ terminó, queda solo para consulta (replay en el futuro)
export const ESTADOS_SESION = ['preparada', 'abierta', 'finalizada'] as const;

export const sesiones = pgTable(
  'sesiones',
  {
    id: serial('id').primaryKey(),
    profesorId: integer('profesor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    escenarioId: integer('escenario_id')
      .notNull()
      .references(() => escenarios.id, { onDelete: 'restrict' }),
    nombre: varchar('nombre', { length: 255 }).notNull(),
    descripcion: text('descripcion'),
    estado: varchar('estado', { length: 20 }).notNull().default('preparada'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    profesorIdx: index('sesiones_profesor_idx').on(table.profesorId),
    estadoIdx: index('sesiones_estado_idx').on(table.estado),
  }),
);

export type DbSesion = typeof sesiones.$inferSelect;
export type NewDbSesion = typeof sesiones.$inferInsert;
