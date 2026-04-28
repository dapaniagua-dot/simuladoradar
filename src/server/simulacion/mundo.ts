// Motor de simulación in-memory de una sesión activa.
// Tick a 10 Hz: cada 100 ms se actualiza el estado de todos los OwnShips
// y se emite por WebSocket a los clientes conectados.

import { MODELO_DEFAULT, type ModeloBuque } from './buques.js';
import type { EstadoBuqueDTO, EstadoAmbienteDTO, TelegrafoId, TickPayload } from '../../shared/types.js';
export type { TickPayload };

const TICK_HZ = 10;
const TICK_MS = 1000 / TICK_HZ;

// 1 milla náutica = 1/60 grados de latitud.
const GRADOS_LAT_POR_MILLA = 1 / 60;

// Tasa máxima a la que el rudder real persigue al comandado (grados/seg).
// El timón físico no salta de 0 a 35° instantáneamente.
const RUDDER_SLEW_DEG_PER_SEC = 4.0;

// Ganancia del autopiloto: cuántos grados de timón pone por cada grado de error.
const AUTOPILOT_GAIN_RUDDER_PER_DEG = 1.5;

export interface PosicionInicial {
  lat: number;
  lon: number;
  headingDeg: number;
}

export interface EstadoBuque {
  ownshipIndex: number;
  alumnoId: number;
  modelo: ModeloBuque;
  // Cinemática
  lat: number;
  lon: number;
  headingDeg: number;
  velocidadKn: number;
  prevHeadingDeg: number;     // para calcular turn rate
  turnRateDegPerMin: number;
  // Distancia acumulada
  distanceTotalNm: number;
  tripStartedAt: number;
  // Comandos del operador
  telegrafo: TelegrafoId;
  rudderCommandDeg: number;   // lo que el alumno pidió
  rudderAngleDeg: number;     // lo que físicamente está
  // Autopiloto
  autopilotOn: boolean;
  setCourseDeg: number;
}

type EmitFn = (payload: TickPayload) => void;

export class Mundo {
  readonly sesionId: number;
  private buques = new Map<number, EstadoBuque>();
  private timer: NodeJS.Timeout | null = null;
  private ultimoTick = Date.now();

  // Por ahora el ambiente es fijo. En el futuro se configura desde la sesión.
  private ambiente: EstadoAmbienteDTO = {
    windSpeedKn: 0,
    windDirectionDeg: 0,
    utcTimestamp: Date.now(),
  };

  constructor(sesionId: number, private readonly emit: EmitFn) {
    this.sesionId = sesionId;
  }

  agregarBuque(
    ownshipIndex: number,
    alumnoId: number,
    posInicial: PosicionInicial,
    modelo: ModeloBuque = MODELO_DEFAULT,
  ): void {
    if (this.buques.has(ownshipIndex)) return;
    const ahora = Date.now();
    this.buques.set(ownshipIndex, {
      ownshipIndex,
      alumnoId,
      modelo,
      lat: posInicial.lat,
      lon: posInicial.lon,
      headingDeg: posInicial.headingDeg,
      velocidadKn: 0,
      prevHeadingDeg: posInicial.headingDeg,
      turnRateDegPerMin: 0,
      distanceTotalNm: 0,
      tripStartedAt: ahora,
      telegrafo: 'STOP',
      rudderCommandDeg: 0,
      rudderAngleDeg: 0,
      autopilotOn: false,
      setCourseDeg: posInicial.headingDeg,
    });
  }

  setTelegrafo(ownshipIndex: number, telegrafo: TelegrafoId): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    b.telegrafo = telegrafo;
    return true;
  }

  // Si el autopiloto está activo, se ignora el rudder manual.
  setRudderCommand(ownshipIndex: number, rudderDeg: number): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    if (b.autopilotOn) return false;
    const max = b.modelo.maxRudderDeg;
    b.rudderCommandDeg = Math.max(-max, Math.min(max, rudderDeg));
    return true;
  }

  setSetCourse(ownshipIndex: number, courseDeg: number): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    b.setCourseDeg = ((courseDeg % 360) + 360) % 360;
    return true;
  }

  setAutopilot(ownshipIndex: number, on: boolean): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    b.autopilotOn = on;
    if (!on) {
      // Al desconectar el autopiloto, dejamos el timón al medio para que
      // el alumno tome el control desde una posición conocida.
      b.rudderCommandDeg = 0;
    }
    return true;
  }

  iniciar(): void {
    if (this.timer) return;
    this.ultimoTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  detener(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  estadoActual(): TickPayload {
    return {
      t: Date.now(),
      buques: [...this.buques.values()].map(toDTO),
      ambiente: { ...this.ambiente, utcTimestamp: Date.now() },
    };
  }

  estaActivo(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    const ahora = Date.now();
    const dt = (ahora - this.ultimoTick) / 1000;
    this.ultimoTick = ahora;
    if (dt <= 0 || dt > 1) return;

    for (const b of this.buques.values()) {
      this.actualizarBuque(b, dt);
    }
    this.emit(this.estadoActual());
  }

  private actualizarBuque(b: EstadoBuque, dt: number): void {
    // 1) Velocidad: converge al objetivo del telégrafo con constante de tiempo tau.
    const objetivo = b.modelo.telegrafo.find((t) => t.id === b.telegrafo);
    const vObj = objetivo?.velObjetivoKn ?? 0;
    const tau = Math.max(1, b.modelo.tauVelocidad);
    b.velocidadKn += ((vObj - b.velocidadKn) * dt) / tau;

    // 2) Autopiloto: si está activo, calcula el rudder command como un P
    //    proporcional al error de heading respecto a setCourse.
    if (b.autopilotOn) {
      const error = anguloError(b.setCourseDeg, b.headingDeg); // -180..+180
      const max = b.modelo.maxRudderDeg;
      const cmd = Math.max(-max, Math.min(max, error * AUTOPILOT_GAIN_RUDDER_PER_DEG));
      b.rudderCommandDeg = cmd;
    }

    // 3) Rudder real persigue al comandado con velocidad de slew limitada.
    const errRudder = b.rudderCommandDeg - b.rudderAngleDeg;
    const maxStep = RUDDER_SLEW_DEG_PER_SEC * dt;
    if (Math.abs(errRudder) <= maxStep) {
      b.rudderAngleDeg = b.rudderCommandDeg;
    } else {
      b.rudderAngleDeg += Math.sign(errRudder) * maxStep;
    }

    // 4) Heading: el timón físico produce una tasa de giro proporcional, escalada
    //    por la eficiencia (que crece con la velocidad real).
    const max = b.modelo.maxRudderDeg;
    const eficacia = Math.min(1, Math.abs(b.velocidadKn) / Math.max(1, b.modelo.velMaxKn / 2));
    const turnRateDegPerSec = (b.rudderAngleDeg / max) * b.modelo.maxTurnRateDegPerSec * eficacia;
    b.headingDeg = normalizeDeg(b.headingDeg + turnRateDegPerSec * dt);

    // 5) Turn rate observado (en grados/minuto, signo igual que el cambio).
    //    Lo medimos desde el último tick (más estable que dHeading/dt directo).
    const dHead = anguloError(b.headingDeg, b.prevHeadingDeg);
    b.turnRateDegPerMin = (dHead / dt) * 60;
    b.prevHeadingDeg = b.headingDeg;

    // 6) Posición y distancia acumulada.
    const millasEnDt = (b.velocidadKn / 3600) * dt;
    const headingRad = (b.headingDeg * Math.PI) / 180;
    const dLat = millasEnDt * Math.cos(headingRad) * GRADOS_LAT_POR_MILLA;
    const factorLon = Math.cos((b.lat * Math.PI) / 180);
    const dLon = (millasEnDt * Math.sin(headingRad) * GRADOS_LAT_POR_MILLA) / Math.max(0.0001, factorLon);
    b.lat += dLat;
    b.lon += dLon;
    b.distanceTotalNm += Math.abs(millasEnDt);
  }
}

function toDTO(b: EstadoBuque): EstadoBuqueDTO {
  const objetivo = b.modelo.telegrafo.find((t) => t.id === b.telegrafo);
  return {
    ownshipIndex: b.ownshipIndex,
    modeloSigla: b.modelo.sigla,
    lat: b.lat,
    lon: b.lon,
    headingDeg: b.headingDeg,
    velocidadKn: b.velocidadKn,
    turnRateDegPerMin: b.turnRateDegPerMin,
    telegrafo: b.telegrafo,
    velObjetivoKn: objetivo?.velObjetivoKn ?? 0,
    rudderCommandDeg: b.rudderCommandDeg,
    rudderAngleDeg: b.rudderAngleDeg,
    autopilotOn: b.autopilotOn,
    setCourseDeg: b.setCourseDeg,
    distanceTotalNm: b.distanceTotalNm,
    tripStartedAt: b.tripStartedAt,
  };
}

function normalizeDeg(d: number): number {
  let r = d % 360;
  if (r < 0) r += 360;
  return r;
}

// Devuelve el error angular corto entre dos rumbos (en grados, rango -180..+180).
// Útil para que el autopiloto gire por el lado más corto.
function anguloError(target: number, actual: number): number {
  let diff = ((target - actual) % 360 + 540) % 360 - 180;
  if (diff === -180) diff = 180;
  return diff;
}
