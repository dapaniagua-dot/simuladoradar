// Blancos del instructor (manual del Melipal, secciones 3.2.1.2 y 3.2.1.3):
//
//   - Directed Target (DT): mantiene rumbo y velocidad. El instructor fija un
//     rumbo y una velocidad "pretendidos"; con la simulación corriendo el
//     blanco se acerca a ellos de forma gradual, y en pausa cambia al instante.
//   - Target (T): recorre una derrota de waypoints, con una velocidad por
//     tramo. Cambia de rumbo solo al pasar cada waypoint y se detiene al final.
//
// La física es simple a propósito (giro con tasa máxima y velocidad con
// constante de tiempo), como la del buque propio antes de la calibración.

import type { BlancoDTO, TipoBlanco, WaypointDTO } from '../../shared/types.js';

// Tasa máxima de giro de un DT (≈ 48°/min) y constante de tiempo de la
// velocidad. Provisorios: el Melipal los tomaba del tipo de buque.
const GIRO_MAX_DEG_S = 0.8;
const TAU_VELOCIDAD_S = 45;
export const VEL_MINIMA_TRAMO_KN = 0.1;
export const VEL_MAXIMA_KN = 40;

export interface Blanco {
  id: string;
  tipo: TipoBlanco;
  numero: number;
  lat: number;
  lon: number;
  headingDeg: number;
  velocidadKn: number;
  rumboPretendido: number;
  velPretendida: number;
  waypoints: WaypointDTO[];
  tramo: number;
  terminado: boolean;
}

export function crearBlanco(
  tipo: TipoBlanco,
  numero: number,
  datos: { lat: number; lon: number; rumbo: number; velKn: number; waypoints?: WaypointDTO[] },
): Blanco {
  const b: Blanco = {
    id: `${tipo}-${numero}`,
    tipo,
    numero,
    lat: datos.lat,
    lon: datos.lon,
    headingDeg: norm360(datos.rumbo),
    velocidadKn: 0,
    rumboPretendido: norm360(datos.rumbo),
    velPretendida: limitarVel(datos.velKn),
    waypoints: [],
    tramo: 0,
    terminado: false,
  };
  if (tipo === 'T') setDerrota(b, datos.waypoints ?? []);
  // Al crearlo ya arranca a la velocidad pedida (como al insertarlo en el Melipal).
  b.velocidadKn = b.velPretendida;
  return b;
}

// Reemplaza la derrota de un Target y lo pone al principio de ella.
export function setDerrota(b: Blanco, waypoints: WaypointDTO[]): void {
  b.waypoints = waypoints.map((w) => ({ lat: w.lat, lon: w.lon, velKn: Math.max(VEL_MINIMA_TRAMO_KN, limitarVel(w.velKn)) }));
  b.tramo = 0;
  b.terminado = b.waypoints.length < 2;
  const w0 = b.waypoints[0];
  if (w0) {
    b.lat = w0.lat;
    b.lon = w0.lon;
    const w1 = b.waypoints[1];
    if (w1) b.headingDeg = b.rumboPretendido = marcacion(w0.lat, w0.lon, w1.lat, w1.lon);
    b.velPretendida = b.terminado ? 0 : w0.velKn;
  }
}

export function actualizarBlanco(b: Blanco, dt: number): void {
  if (b.tipo === 'T') {
    guiarPorDerrota(b, dt);
  } else {
    // DT: el rumbo se acerca al pretendido por el lado más corto.
    const error = anguloError(b.rumboPretendido, b.headingDeg);
    const paso = GIRO_MAX_DEG_S * dt;
    b.headingDeg = Math.abs(error) <= paso ? b.rumboPretendido : norm360(b.headingDeg + Math.sign(error) * paso);
  }
  b.velocidadKn += ((b.velPretendida - b.velocidadKn) * dt) / TAU_VELOCIDAD_S;
  avanzar(b, dt);
}

// Target: apunta al próximo waypoint; al llegar, pasa al tramo siguiente con
// su velocidad. En el último, se detiene.
function guiarPorDerrota(b: Blanco, dt: number): void {
  if (b.terminado) {
    b.velPretendida = 0;
    return;
  }
  const destino = b.waypoints[b.tramo + 1];
  if (!destino) {
    b.terminado = true;
    return;
  }
  const distNm = distancia(b.lat, b.lon, destino.lat, destino.lon);
  const pasoNm = (Math.max(b.velocidadKn, 0.1) / 3600) * dt;
  if (distNm <= pasoNm * 1.5) {
    b.lat = destino.lat;
    b.lon = destino.lon;
    b.tramo++;
    const siguiente = b.waypoints[b.tramo + 1];
    if (!siguiente) {
      b.terminado = true;
      b.velPretendida = 0;
      return;
    }
    b.velPretendida = b.waypoints[b.tramo]!.velKn;
  }
  const w = b.waypoints[b.tramo + 1]!;
  b.headingDeg = b.rumboPretendido = marcacion(b.lat, b.lon, w.lat, w.lon);
}

function avanzar(b: Blanco, dt: number): void {
  const millas = (b.velocidadKn / 3600) * dt;
  const r = (b.headingDeg * Math.PI) / 180;
  b.lat += (Math.cos(r) * millas) / 60;
  b.lon += (Math.sin(r) * millas) / (60 * Math.max(0.0001, Math.cos((b.lat * Math.PI) / 180)));
}

export function toBlancoDTO(b: Blanco): BlancoDTO {
  return {
    id: b.id,
    tipo: b.tipo,
    numero: b.numero,
    lat: b.lat,
    lon: b.lon,
    headingDeg: b.headingDeg,
    velocidadKn: b.velocidadKn,
    rumboPretendido: b.rumboPretendido,
    velPretendida: b.velPretendida,
    waypoints: b.waypoints,
    tramo: b.tramo,
    terminado: b.terminado,
  };
}

export function limitarVel(v: number): number {
  return Math.max(0, Math.min(VEL_MAXIMA_KN, Number.isFinite(v) ? v : 0));
}

export function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

function anguloError(objetivo: number, actual: number): number {
  let e = (objetivo - actual) % 360;
  if (e > 180) e -= 360;
  if (e < -180) e += 360;
  return e;
}

function marcacion(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const xE = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const yN = lat2 - lat1;
  return norm360((Math.atan2(xE, yN) * 180) / Math.PI);
}

function distancia(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const xE = (lon2 - lon1) * 60 * Math.cos((lat1 * Math.PI) / 180);
  const yN = (lat2 - lat1) * 60;
  return Math.hypot(xE, yN);
}
