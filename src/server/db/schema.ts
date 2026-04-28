import { pgTable, serial, varchar, timestamp, index } from 'drizzle-orm/pg-core';

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
