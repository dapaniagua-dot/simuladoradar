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
