// Motor de simulación in-memory de una sesión activa.
// Tick a 10 Hz: cada 100 ms se actualiza el estado de todos los OwnShips
// y se emite por WebSocket a los clientes conectados.

import { MODELO_DEFAULT, type ModeloBuque } from './buques.js';
import {
  actualizarBlanco, crearBlanco, limitarVel, norm360, setDerrota, toBlancoDTO, type Blanco,
} from './blancos.js';
import { SIN_FALLAS } from '../../shared/types.js';
import type {
  EstadoBuqueDTO,
  EstadoAmbienteDTO,
  TelegrafoId,
  TickPayload,
  MensajeVHF,
  MensajeNavtex,
  MensajePrivado,
  PuntoTraza,
  FallasBuque,
  DatosEjercicio,
  CrearBlancoPayload,
  ModificarBlancoPayload,
} from '../../shared/types.js';
export type { TickPayload };

const HISTORIAL_MENSAJES_MAX = 100;

// Recorrido (trace): un punto cada 5 s, hasta 4 horas por buque. La carta del
// alumno submuestrea según el intervalo que elija.
const TRAZA_INTERVALO_MS = 5000;
const TRAZA_MAX_PUNTOS = (4 * 3600 * 1000) / TRAZA_INTERVALO_MS;

const TICK_HZ = 10;
const TICK_MS = 1000 / TICK_HZ;

// 1 milla náutica = 1/60 grados de latitud.
const GRADOS_LAT_POR_MILLA = 1 / 60;

// Tasa máxima a la que el rudder real persigue al comandado (grados/seg).
// El timón físico no salta de 0 a 35° instantáneamente.
const RUDDER_SLEW_DEG_PER_SEC = 4.0;

// Ganancia del autopiloto: cuántos grados de timón pone por cada grado de error.
const AUTOPILOT_GAIN_RUDDER_PER_DEG = 1.5;

// Constante de tiempo con la que el giro por empuje diferencial de las hélices
// se establece (segundos). Las máquinas tardan en tomar vueltas, así que el
// giro no aparece instantáneo al mover una palanca.
const TAU_GIRO_DIFERENCIAL_S = 10;

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
  // Comandos del operador: una palanca por máquina
  telegrafoBabor: TelegrafoId;
  telegrafoEstribor: TelegrafoId;
  giroDiferencialDegPerSec: number; // aporte actual de las hélices al giro
  rudderCommandDeg: number;   // lo que el alumno pidió
  rudderAngleDeg: number;     // lo que físicamente está
  // Autopiloto
  autopilotOn: boolean;
  // Fallas inducidas y control del instructor
  fallas: FallasBuque;
  giroCongeladoDeg: number;
  controlInstructor: boolean;
  setCourseDeg: number;
  // Recorrido realizado
  traza: PuntoTraza[];
}

type EmitFn = (payload: TickPayload) => void;
type TrazaFn = (ownshipIndex: number, punto: PuntoTraza) => void;

export class Mundo {
  readonly sesionId: number;
  private buques = new Map<number, EstadoBuque>();
  // Blancos del instructor. Viven en memoria mientras la sesión está abierta.
  private blancos = new Map<string, Blanco>();
  private contadorBlancos = { DT: 0, T: 0 };
  private timer: NodeJS.Timeout | null = null;
  private ultimoTick = Date.now();
  private pausado = false;

  // Historiales acotados de mensajes para que un cliente que se reconecta
  // pueda recibir los últimos N mensajes sin tener que re-loguear el chat.
  private mensajesVHF: MensajeVHF[] = [];
  private mensajesNavtex: MensajeNavtex[] = [];
  private mensajesPrivados: MensajePrivado[] = [];
  private ultimaMuestraTraza = 0;

  // Por ahora el ambiente es fijo. En el futuro se configura desde la sesión.
  private ambiente: EstadoAmbienteDTO = {
    windSpeedKn: 0,
    windDirectionDeg: 0,
    utcTimestamp: Date.now(),
  };

  constructor(
    sesionId: number,
    private readonly emit: EmitFn,
    private readonly onTraza: TrazaFn = () => {},
  ) {
    this.sesionId = sesionId;
  }

  quitarBuque(ownshipIndex: number): void {
    this.buques.delete(ownshipIndex);
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
      telegrafoBabor: 'STOP',
      telegrafoEstribor: 'STOP',
      giroDiferencialDegPerSec: 0,
      rudderCommandDeg: 0,
      rudderAngleDeg: 0,
      autopilotOn: false,
      setCourseDeg: posInicial.headingDeg,
      fallas: { ...SIN_FALLAS },
      giroCongeladoDeg: posInicial.headingDeg,
      controlInstructor: false,
      traza: [{ t: ahora, lat: posInicial.lat, lon: posInicial.lon }],
    });
  }

  setTelegrafo(ownshipIndex: number, maquina: 'babor' | 'estribor', telegrafo: TelegrafoId): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    if (maquina === 'babor') b.telegrafoBabor = telegrafo;
    else b.telegrafoEstribor = telegrafo;
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
    // El autopiloto no conecta si está en falla o si falló el giro (no tiene
    // rumbo contra el cual gobernar).
    if (on && (b.fallas.autopiloto || b.fallas.giro)) return false;
    b.autopilotOn = on;
    if (!on) {
      // Al desconectar el autopiloto, dejamos el timón al medio para que
      // el alumno tome el control desde una posición conocida.
      b.rudderCommandDeg = 0;
    }
    return true;
  }

  // ===== Fallas inducidas y control del instructor =====
  setFallas(ownshipIndex: number, cambios: Partial<FallasBuque>): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    // Al fallar el giro, los repetidores quedan clavados en el último rumbo.
    if (cambios.giro && !b.fallas.giro) b.giroCongeladoDeg = b.headingDeg;
    b.fallas = { ...b.fallas, ...cambios };
    if (b.fallas.autopiloto || b.fallas.giro) b.autopilotOn = false;
    return true;
  }

  setControlInstructor(ownshipIndex: number, tomar: boolean): boolean {
    const b = this.buques.get(ownshipIndex);
    if (!b) return false;
    b.controlInstructor = tomar;
    return true;
  }

  controlInstructor(ownshipIndex: number): boolean {
    return this.buques.get(ownshipIndex)?.controlInstructor ?? false;
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

  pausar(): void {
    this.pausado = true;
  }

  reanudar(): void {
    if (this.pausado) {
      this.pausado = false;
      // Reset del último tick para que el dt del siguiente frame no incluya
      // la duración de la pausa.
      this.ultimoTick = Date.now();
    }
  }

  estaPausado(): boolean {
    return this.pausado;
  }

  // ===== Mensajería =====
  guardarVHF(m: MensajeVHF): void {
    this.mensajesVHF.push(m);
    while (this.mensajesVHF.length > HISTORIAL_MENSAJES_MAX) this.mensajesVHF.shift();
  }
  guardarNavtex(m: MensajeNavtex): void {
    this.mensajesNavtex.push(m);
    while (this.mensajesNavtex.length > HISTORIAL_MENSAJES_MAX) this.mensajesNavtex.shift();
  }
  guardarPrivado(m: MensajePrivado): void {
    this.mensajesPrivados.push(m);
    while (this.mensajesPrivados.length > HISTORIAL_MENSAJES_MAX) this.mensajesPrivados.shift();
  }

  // Snapshot de los mensajes recientes — los nuevos clientes los reciben al
  // conectarse para no quedarse en blanco. Los privados se filtran por user.
  snapshotMensajes(userId: number): {
    vhf: MensajeVHF[];
    navtex: MensajeNavtex[];
    privados: MensajePrivado[];
  } {
    return {
      vhf: [...this.mensajesVHF],
      navtex: [...this.mensajesNavtex],
      privados: this.mensajesPrivados.filter(
        (m) => m.deUserId === userId || m.paraUserId === userId,
      ),
    };
  }

  // ===== Blancos del instructor =====
  agregarBlanco(p: CrearBlancoPayload): Blanco {
    const numero = ++this.contadorBlancos[p.tipo];
    const b = crearBlanco(p.tipo, numero, p);
    this.blancos.set(b.id, b);
    return b;
  }

  // Con la simulación en pausa los cambios son instantáneos; corriendo, el
  // blanco tiende a los valores pedidos (manual del Melipal, 3.5.6).
  modificarBlanco(p: ModificarBlancoPayload): boolean {
    const b = this.blancos.get(p.id);
    if (!b) return false;
    if (p.lat !== undefined && p.lon !== undefined) {
      b.lat = p.lat;
      b.lon = p.lon;
    }
    if (p.rumbo !== undefined && b.tipo === 'DT') {
      b.rumboPretendido = norm360(p.rumbo);
      if (this.pausado) b.headingDeg = b.rumboPretendido;
    }
    if (p.velKn !== undefined && b.tipo === 'DT') {
      b.velPretendida = limitarVel(p.velKn);
      if (this.pausado) b.velocidadKn = b.velPretendida;
    }
    if (p.waypoints && b.tipo === 'T') {
      // Solo cambian las velocidades de los tramos: el blanco sigue donde está.
      const mismaDerrota = p.waypoints.length === b.waypoints.length
        && p.waypoints.every((w, i) => w.lat === b.waypoints[i]!.lat && w.lon === b.waypoints[i]!.lon);
      if (mismaDerrota) {
        b.waypoints.forEach((w, i) => { w.velKn = Math.max(0.1, limitarVel(p.waypoints![i]!.velKn)); });
        if (!b.terminado) b.velPretendida = b.waypoints[b.tramo]!.velKn;
        if (this.pausado) b.velocidadKn = b.velPretendida;
      } else {
        setDerrota(b, p.waypoints);
        if (this.pausado) b.velocidadKn = b.velPretendida;
      }
    }
    return true;
  }

  borrarBlanco(id: string): boolean {
    return this.blancos.delete(id);
  }

  // ===== Ejercicios guardados =====
  // Foto de la situación actual para guardarla como ejercicio.
  exportarEjercicio(): DatosEjercicio {
    return {
      version: 1,
      buques: [...this.buques.values()].map((b) => ({
        ownshipIndex: b.ownshipIndex, lat: b.lat, lon: b.lon, headingDeg: b.headingDeg,
      })),
      blancos: [...this.blancos.values()].map((b) => (b.tipo === 'T'
        ? { tipo: 'T', lat: b.lat, lon: b.lon, rumbo: b.headingDeg, velKn: b.velPretendida, waypoints: b.waypoints.map((w) => ({ ...w })) }
        : { tipo: 'DT', lat: b.lat, lon: b.lon, rumbo: b.rumboPretendido, velKn: b.velPretendida })),
    };
  }

  // Carga un ejercicio: reemplaza los blancos y lleva cada buque propio a su
  // posición guardada, detenido y con los comandos en cero (arranca de nuevo).
  cargarEjercicio(datos: DatosEjercicio): void {
    this.blancos.clear();
    this.contadorBlancos = { DT: 0, T: 0 };
    for (const b of datos.blancos) this.agregarBlanco(b);
    const ahora = Date.now();
    for (const pos of datos.buques) {
      const b = this.buques.get(pos.ownshipIndex);
      if (!b) continue;
      Object.assign(b, {
        lat: pos.lat,
        lon: pos.lon,
        headingDeg: pos.headingDeg,
        prevHeadingDeg: pos.headingDeg,
        velocidadKn: 0,
        turnRateDegPerMin: 0,
        telegrafoBabor: 'STOP',
        telegrafoEstribor: 'STOP',
        giroDiferencialDegPerSec: 0,
        rudderCommandDeg: 0,
        rudderAngleDeg: 0,
        autopilotOn: false,
        setCourseDeg: pos.headingDeg,
        distanceTotalNm: 0,
        tripStartedAt: ahora,
        fallas: { ...SIN_FALLAS },
        giroCongeladoDeg: pos.headingDeg,
        traza: [{ t: ahora, lat: pos.lat, lon: pos.lon }],
      });
    }
  }

  estadoActual(): TickPayload {
    return {
      t: Date.now(),
      buques: [...this.buques.values()].map(toDTO),
      blancos: [...this.blancos.values()].map(toBlancoDTO),
      ambiente: { ...this.ambiente, utcTimestamp: Date.now() },
      pausado: this.pausado,
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

    // En pausa no actualizamos la física pero seguimos emitiendo ticks para
    // que los clientes mantengan la conexión y reciban el estado congelado.
    if (!this.pausado) {
      for (const bl of this.blancos.values()) actualizarBlanco(bl, dt);
      for (const b of this.buques.values()) {
        this.actualizarBuque(b, dt);
      }
    }
    this.emit(this.estadoActual());
    if (!this.pausado && ahora - this.ultimaMuestraTraza >= TRAZA_INTERVALO_MS) {
      this.ultimaMuestraTraza = ahora;
      this.muestrearTraza(ahora);
    }
  }

  private muestrearTraza(ahora: number): void {
    for (const b of this.buques.values()) {
      // Buque quieto: no agregamos puntos repetidos.
      const ultimo = b.traza[b.traza.length - 1];
      if (ultimo && ultimo.lat === b.lat && ultimo.lon === b.lon) continue;
      const punto = { t: ahora, lat: b.lat, lon: b.lon };
      b.traza.push(punto);
      if (b.traza.length > TRAZA_MAX_PUNTOS) b.traza.shift();
      this.onTraza(b.ownshipIndex, punto);
    }
  }

  // Recorridos para un cliente que se conecta: el alumno solo recibe el suyo
  // (como con un GPS real, no ve la derrota de los demás); el profesor, todos.
  snapshotTrazas(soloOwnship?: number): Record<number, PuntoTraza[]> {
    const out: Record<number, PuntoTraza[]> = {};
    for (const b of this.buques.values()) {
      if (soloOwnship !== undefined && b.ownshipIndex !== soloOwnship) continue;
      out[b.ownshipIndex] = [...b.traza];
    }
    return out;
  }

  private actualizarBuque(b: EstadoBuque, dt: number): void {
    // 1) Velocidad: converge, con constante de tiempo tau, a la que daría el
    //    promedio de RPM de las dos máquinas. Se promedian RPM y no
    //    velocidades porque la tabla de velocidades es asimétrica (atrás el
    //    buque anda mucho menos): con una avante y otra atrás a full las RPM
    //    se cancelan y el buque gira casi en el lugar, como en la realidad.
    // Con la máquina en falla no hay propulsión: el buque va frenando.
    const rpmBabor = b.fallas.maquina ? 0 : rpmDe(b.modelo, b.telegrafoBabor);
    const rpmEstribor = b.fallas.maquina ? 0 : rpmDe(b.modelo, b.telegrafoEstribor);
    const vObj = velObjetivoPorRpm(b.modelo, (rpmBabor + rpmEstribor) / 2);
    const tau = Math.max(1, b.modelo.tauVelocidad);
    b.velocidadKn += ((vObj - b.velocidadKn) * dt) / tau;

    // 1b) Empuje diferencial: si babor empuja más que estribor la proa cae a
    //     estribor (heading crece), y al revés. Funciona aun con el buque
    //     parado, que es justamente para lo que se usa al maniobrar.
    const rpmMax = Math.max(1, ...b.modelo.telegrafo.map((t) => Math.abs(t.rpm)));
    const giroObj = ((rpmBabor - rpmEstribor) / (2 * rpmMax)) * b.modelo.maxTurnRateDiferencialDegPerSec;
    b.giroDiferencialDegPerSec += ((giroObj - b.giroDiferencialDegPerSec) * dt) / TAU_GIRO_DIFERENCIAL_S;

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
    const turnRateDegPerSec =
      (b.rudderAngleDeg / max) * b.modelo.maxTurnRateDegPerSec * eficacia + b.giroDiferencialDegPerSec;
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

function rpmDe(modelo: ModeloBuque, telegrafo: TelegrafoId): number {
  return modelo.telegrafo.find((t) => t.id === telegrafo)?.rpm ?? 0;
}

// Interpola linealmente en la tabla RPM → velocidad del modelo.
function velObjetivoPorRpm(modelo: ModeloBuque, rpm: number): number {
  const tabla = [...modelo.telegrafo].sort((a, b) => a.rpm - b.rpm);
  if (rpm <= tabla[0]!.rpm) return tabla[0]!.velObjetivoKn;
  for (let i = 1; i < tabla.length; i++) {
    const a = tabla[i - 1]!;
    const b = tabla[i]!;
    if (rpm <= b.rpm) {
      return a.velObjetivoKn + ((rpm - a.rpm) / (b.rpm - a.rpm)) * (b.velObjetivoKn - a.velObjetivoKn);
    }
  }
  return tabla[tabla.length - 1]!.velObjetivoKn;
}

function toDTO(b: EstadoBuque): EstadoBuqueDTO {
  return {
    ownshipIndex: b.ownshipIndex,
    modeloSigla: b.modelo.sigla,
    lat: b.lat,
    lon: b.lon,
    headingDeg: b.headingDeg,
    velocidadKn: b.velocidadKn,
    turnRateDegPerMin: b.turnRateDegPerMin,
    telegrafoBabor: b.telegrafoBabor,
    telegrafoEstribor: b.telegrafoEstribor,
    velObjetivoKn: velObjetivoPorRpm(b.modelo, (rpmDe(b.modelo, b.telegrafoBabor) + rpmDe(b.modelo, b.telegrafoEstribor)) / 2),
    rudderCommandDeg: b.rudderCommandDeg,
    rudderAngleDeg: b.rudderAngleDeg,
    autopilotOn: b.autopilotOn,
    setCourseDeg: b.setCourseDeg,
    distanceTotalNm: b.distanceTotalNm,
    tripStartedAt: b.tripStartedAt,
    fallas: b.fallas,
    giroCongeladoDeg: b.giroCongeladoDeg,
    controlInstructor: b.controlInstructor,
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
