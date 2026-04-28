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

// Resultado del parser de cartas (.map). Coordenadas siempre en grados decimales
// (positivo norte / este, negativo sur / oeste).
export interface CartaCoord {
  lat: number;
  lon: number;
  px: number;
  py: number;
}

export interface CartaSegmento {
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  intensidad: number;
  altura: number;
  px1: number;
  py1: number;
  px2: number;
  py2: number;
}

export interface CartaParseada {
  rasterUrl: string;
  ancho: number;
  alto: number;
  esquinaNW: CartaCoord;
  esquinaSE: CartaCoord;
  segmentos: CartaSegmento[];
}
