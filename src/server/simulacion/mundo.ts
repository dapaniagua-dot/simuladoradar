// Motor de simulación in-memory de una sesión activa.
// Cada sesión abierta tiene una instancia de Mundo viva en el server.
// Tick a 10 Hz: cada 100 ms se actualiza el estado de todos los OwnShips
// y se emite por WebSocket a los clientes conectados a la room de la sesión.

import { MODELO_DEFAULT, type ModeloBuque } from './buques.js';
import type { EstadoBuqueDTO, TelegrafoId, TickPayload } from '../../shared/types.js';
export type { TickPayload };

const TICK_HZ = 10;
const TICK_MS = 1000 / TICK_HZ;

// 1 milla náutica = 1/60 grados de latitud.
const GRADOS_LAT_POR_MILLA = 1 / 60;

export interface PosicionInicial {
  lat: number;
  lon: number;
  headingDeg: number; // 0 = norte, 90 = este
}

export interface EstadoBuque {
  ownshipIndex: number;
  alumnoId: number;
  modelo: ModeloBuque;
  // Estado físico instantáneo
  lat: number;
  lon: number;
  headingDeg: number;
  velocidadKn: number;
  // Comandos del operador
  telegrafo: TelegrafoId;
  rudderDeg: number; // negativo = babor, positivo = estribor
}

type EmitFn = (payload: TickPayload) => void;

export class Mundo {
  readonly sesionId: number;
  private buques = new Map<number, EstadoBuque>();
  private timer: NodeJS.Timeout | null = null;
  private ultimoTick = Date.now();

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
    this.buques.set(ownshipIndex, {
      ownshipIndex,
      alumnoId,
      modelo,
      lat: posInicial.lat,
      lon: posInicial.lon,
      headingDeg: posInicial.headingDeg,
      velocidadKn: 0,
      telegrafo: 'STOP',
      rudderDeg: 0,
    });
  }

  setTelegrafo(ownshipIndex: number, telegrafo: TelegrafoId): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    b.telegrafo = telegrafo;
    return true;
  }

  setRudder(ownshipIndex: number, rudderDeg: number): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    const max = b.modelo.maxRudderDeg;
    b.rudderDeg = Math.max(-max, Math.min(max, rudderDeg));
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
    };
  }

  estaActivo(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    const ahora = Date.now();
    const dt = (ahora - this.ultimoTick) / 1000; // segundos
    this.ultimoTick = ahora;
    if (dt <= 0 || dt > 1) return; // protección contra deltas raros (suspensión, GC, etc.)

    for (const b of this.buques.values()) {
      this.actualizarBuque(b, dt);
    }
    this.emit(this.estadoActual());
  }

  private actualizarBuque(b: EstadoBuque, dt: number): void {
    // 1) Velocidad: converge al objetivo del telégrafo con constante de tiempo tau.
    //    dv/dt = (vObj - v) / tau   →   integración explícita
    const objetivo = b.modelo.telegrafo.find((t) => t.id === b.telegrafo);
    const vObj = objetivo?.velObjetivoKn ?? 0;
    const tau = Math.max(1, b.modelo.tauVelocidad);
    b.velocidadKn += ((vObj - b.velocidadKn) * dt) / tau;

    // 2) Heading: tasa de giro proporcional al timón. A timón completo gira a maxTurnRateDegPerSec.
    //    Si el barco está casi parado o yendo muy despacio, el timón pierde efectividad
    //    (factor de eficacia que escala con la velocidad real / velMax).
    const max = b.modelo.maxRudderDeg;
    const eficacia = Math.min(1, Math.abs(b.velocidadKn) / Math.max(1, b.modelo.velMaxKn / 2));
    const turnRate = (b.rudderDeg / max) * b.modelo.maxTurnRateDegPerSec * eficacia;
    b.headingDeg = normalizeDeg(b.headingDeg + turnRate * dt);

    // 3) Posición: avanzo en la dirección del heading a la velocidad actual.
    //    velocidad en knots = millas náuticas / hora → millas / segundo = / 3600.
    const millasEnDt = (b.velocidadKn / 3600) * dt;
    const headingRad = (b.headingDeg * Math.PI) / 180;
    // Componente norte (cos del heading desde norte) → cambio en latitud.
    // Componente este (sin del heading) → cambio en longitud.
    const dLat = millasEnDt * Math.cos(headingRad) * GRADOS_LAT_POR_MILLA;
    const factorLon = Math.cos((b.lat * Math.PI) / 180); // millas por grado de longitud disminuye con la latitud
    const dLon = millasEnDt * Math.sin(headingRad) * GRADOS_LAT_POR_MILLA / Math.max(0.0001, factorLon);
    b.lat += dLat;
    b.lon += dLon;
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
    telegrafo: b.telegrafo,
    velObjetivoKn: objetivo?.velObjetivoKn ?? 0,
    rudderDeg: b.rudderDeg,
  };
}

function normalizeDeg(d: number): number {
  let r = d % 360;
  if (r < 0) r += 360;
  return r;
}
