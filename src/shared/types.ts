export const ROLES = ['admin', 'profesor', 'alumno'] as const;
export type Role = (typeof ROLES)[number];

export interface PublicUser {
  id: number;
  email: string;
  nombre: string;
  role: Role;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: PublicUser;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  nombre: string;
  role: Role;
}

export interface ApiError {
  error: string;
}

export interface Escenario {
  id: number;
  nombre: string;
  slug: string;
  descripcion: string | null;
}

export const ESTADOS_SESION = ['preparada', 'abierta', 'finalizada'] as const;
export type EstadoSesion = (typeof ESTADOS_SESION)[number];

export interface Sesion {
  id: number;
  nombre: string;
  descripcion: string | null;
  estado: EstadoSesion;
  escenarioId: number;
  escenarioNombre: string;
  profesorId: number;
  createdAt: string;
  openedAt: string | null;
  closedAt: string | null;
}

export interface CreateSesionRequest {
  nombre: string;
  descripcion?: string;
  escenarioId: number;
}

export const MAX_OWNSHIPS_POR_SESION = 5;

export interface Participacion {
  id: number;
  sesionId: number;
  alumnoId: number;
  alumnoEmail: string;
  alumnoNombre: string;
  ownshipIndex: number;
  createdAt: string;
}

// El alumno ve esto cuando pide /api/mis-sesiones: solo sesiones abiertas
// donde fue asignado, con su número de OwnShip.
export interface SesionDelAlumno {
  id: number;
  nombre: string;
  descripcion: string | null;
  escenarioNombre: string;
  ownshipIndex: number;
  openedAt: string | null;
}

// Resultado del parser de cartas (.map). Coordenadas siempre en grados decimales
// (positivo norte / este, negativo sur / oeste).
export interface CartaCoord {
  lat: number;
  lon: number;
  px: number;
  py: number;
}

// Cada segmento contiene los dos extremos en grados decimales y también
// las coordenadas pre-calculadas en millas náuticas relativas a la carta:
// X = millas al este desde el NW corner, Y = millas al norte desde el SE corner.
// (Es el formato nativo del .map; el motor del radar de Melipal opera en millas).
export interface CartaSegmento {
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  intensidad: number;
  altura: number;
  xMillas1: number;
  yMillas1: number;
  xMillas2: number;
  yMillas2: number;
}

export interface CartaParseada {
  rasterUrl: string;
  altoMillas: number;
  anchoMillas: number;
  esquinaNW: CartaCoord;
  esquinaSE: CartaCoord;
  segmentos: CartaSegmento[];
}
