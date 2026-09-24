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
  // Posición inicial elegida por el profesor antes de abrir la sesión.
  // Si vienen null el registry usa el reparto automático alrededor del centro
  // de la carta. Una vez abierta la sesión no se modifican más.
  latInicial: number | null;
  lonInicial: number | null;
  headingInicial: number | null;
  createdAt: string;
}

export interface SetPosicionInicialRequest {
  lat: number;
  lon: number;
  headingDeg: number;
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

// =============================================================================
// Tipos para la simulación (compartidos cliente ↔ server vía Socket.IO)
// =============================================================================

// Posiciones del telégrafo del Melipal: 10, incluyendo MAN (Manoeuvring,
// entre Full y Half Ahead). El buque tiene dos máquinas y cada una tiene su
// propia palanca.
export type TelegrafoId =
  | 'FAS'
  | 'HAS'
  | 'SAS'
  | 'DSAS'
  | 'STOP'
  | 'DSAH'
  | 'SAH'
  | 'HAH'
  | 'MAN'
  | 'FAH';

export const TELEGRAFO_IDS: readonly TelegrafoId[] = [
  'FAS', 'HAS', 'SAS', 'DSAS', 'STOP', 'DSAH', 'SAH', 'HAH', 'MAN', 'FAH',
];

export interface PosicionTelegrafo {
  id: TelegrafoId;
  nombre: string;
  rpm: number;            // vueltas de la máquina en esa posición (fleet.cfg)
  velObjetivoKn: number;  // velocidad con las dos máquinas en esa posición
}

// Estado público de un buque que el server emite por tick.
export interface EstadoBuqueDTO {
  ownshipIndex: number;
  modeloSigla: string;
  // Posición y movimiento
  lat: number;
  lon: number;
  headingDeg: number;       // rumbo actual del giroscompás (0-360)
  velocidadKn: number;      // velocidad sobre el agua (knots)
  turnRateDegPerMin: number;// tasa de giro instantánea (grados/minuto, signo = lado)
  // Comandos del operador: una palanca por máquina
  telegrafoBabor: TelegrafoId;
  telegrafoEstribor: TelegrafoId;
  velObjetivoKn: number;    // la que dan las RPM promedio de las dos máquinas
  rudderCommandDeg: number; // ángulo comandado (-35..+35)
  rudderAngleDeg: number;   // ángulo real del timón (puede ir lento al comandado)
  // Autopiloto
  autopilotOn: boolean;
  setCourseDeg: number;     // rumbo objetivo del autopiloto (0-360)
  // Métricas acumuladas
  distanceTotalNm: number;  // millas náuticas recorridas desde el arranque
  tripStartedAt: number;    // timestamp ms cuando arrancó la sesión
  // Fallas que provoca el instructor y lectura congelada del giro.
  fallas: FallasBuque;
  giroCongeladoDeg: number; // último rumbo que marcó el giro antes de fallar
  // El instructor tomó el control del buque ("Switch Ctrl" del Melipal).
  controlInstructor: boolean;
}

// Fallas inducidas por el instructor (pestañas Command y Radar de cada Own
// Ship en el Melipal).
export interface FallasBuque {
  gps: boolean;
  giro: boolean;
  log: boolean;
  autopiloto: boolean;
  maquina: boolean;
  radar: boolean;            // radar fuera de servicio
  sectorCiegoDeg: number;    // amplitud del sector ciego a popa (0 = sin sector)
  ecoFalsoDeg: number | null; // marcación relativa del eco falso (null = sin eco falso)
}

export const SIN_FALLAS: FallasBuque = {
  gps: false, giro: false, log: false, autopiloto: false, maquina: false,
  radar: false, sectorCiegoDeg: 0, ecoFalsoDeg: null,
};

// Estado ambiental del mundo (compartido por todos los buques de la sesión).
// En MVP 3.5 viene mockeado con valores fijos. En MVP futuro se conecta a un
// modelo meteorológico que el profesor configura desde la sesión.
export interface EstadoAmbienteDTO {
  windSpeedKn: number;      // velocidad del viento (knots)
  windDirectionDeg: number; // dirección DESDE donde sopla (0-360)
  utcTimestamp: number;     // timestamp UTC del server (ms)
}

// Punto del recorrido (trace) de un buque. El server toma uno cada pocos
// segundos para que la carta pueda dibujar la derrota realizada.
export interface PuntoTraza {
  t: number;   // timestamp ms
  lat: number;
  lon: number;
}

export interface TrazaPuntoPayload {
  ownshipIndex: number;
  punto: PuntoTraza;
}

// Qué pantalla abrió un cliente al conectarse por socket.
export type VistaCliente = 'aula' | 'radar' | 'instructor';

// Cuántas pantallas tiene abiertas cada alumno (por ownshipIndex). Lo usa el
// instructor para mostrar si el alumno está conectado.
export interface PresenciaOS {
  aula: number;
  radar: number;
}
export type PresenciaEstado = Record<number, PresenciaOS>;

export interface PresenciaEvento {
  ownshipIndex: number;
  nombre: string;
  vista: 'aula' | 'radar';
  conectado: boolean;
  ts: number;
}

// Blancos del instructor: Directed Targets (rumbo y velocidad que fija el
// profesor) y Targets (siguen una derrota de waypoints).
export type TipoBlanco = 'DT' | 'T';

// velKn: velocidad del tramo que EMPIEZA en este waypoint.
export interface WaypointDTO {
  lat: number;
  lon: number;
  velKn: number;
}

export interface BlancoDTO {
  id: string;            // "DT-1", "T-2"
  tipo: TipoBlanco;
  numero: number;
  lat: number;
  lon: number;
  headingDeg: number;
  velocidadKn: number;
  rumboPretendido: number;
  velPretendida: number;
  waypoints: WaypointDTO[]; // solo Targets
  tramo: number;            // índice del waypoint desde el que navega
  terminado: boolean;       // Target que llegó al final de su derrota
}

export interface CrearBlancoPayload {
  tipo: TipoBlanco;
  lat: number;
  lon: number;
  rumbo: number;
  velKn: number;
  waypoints?: WaypointDTO[];
}

export interface ModificarBlancoPayload {
  id: string;
  rumbo?: number;
  velKn?: number;
  lat?: number;
  lon?: number;
  waypoints?: WaypointDTO[];
}

export interface TickPayload {
  t: number;
  buques: EstadoBuqueDTO[];
  blancos: BlancoDTO[];
  ambiente: EstadoAmbienteDTO;
  pausado: boolean;
}

// Comandos que el cliente envía al server por Socket.IO.
export interface ShipControlPayload {
  // Solo cuando manda el instructor con el control tomado: a qué buque va.
  ownshipIndex?: number;
  telegrafoBabor?: TelegrafoId;
  telegrafoEstribor?: TelegrafoId;
  rudderCommandDeg?: number;
  setCourseDeg?: number;
  autopilotOn?: boolean;
}

// =============================================================================
// Comunicaciones (MVP 6): VHF, Navtex, mensajes privados
// =============================================================================

// Canales VHF que soporta el simulador. 16 es el universal de emergencia y
// llamada inicial; el resto se usa para conversaciones después del contacto.
export const CANALES_VHF = [6, 8, 10, 12, 13, 14, 16, 67, 71, 72, 77] as const;
export type CanalVHF = (typeof CANALES_VHF)[number];

export interface MensajeVHF {
  id: string;
  canal: CanalVHF;
  remitenteUserId: number;
  remitenteNombre: string;     // nombre legible (ej: "Profesor", "OS-1: Juan Pérez")
  texto: string;
  ts: number;                  // timestamp ms
}

export interface VHFTransmitPayload {
  canal: CanalVHF;
  texto: string;
}

export interface MensajeNavtex {
  id: string;
  texto: string;
  ts: number;
}

export interface NavtexSendPayload {
  texto: string;
}

// Mensaje privado de un profesor a un alumno específico de su sesión.
export interface MensajePrivado {
  id: string;
  deUserId: number;
  paraUserId: number;
  texto: string;
  ts: number;
}

export interface DmSendPayload {
  paraUserId: number;
  texto: string;
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

// =============================================================================
// Ejercicios guardados
// =============================================================================

// Situación que se guarda y se vuelve a cargar: dónde está cada buque propio
// (por número de OS) y los blancos del instructor.
export interface DatosEjercicio {
  version: 1;
  buques: { ownshipIndex: number; lat: number; lon: number; headingDeg: number }[];
  blancos: CrearBlancoPayload[];
}

export interface EjercicioResumen {
  id: number;
  nombre: string;
  descripcion: string | null;
  escenarioId: number;
  cantBuques: number;
  cantBlancos: number;
  updatedAt: string;
}
