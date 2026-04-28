import { io, type Socket } from 'socket.io-client';
import { Dial } from './aula/dial.js';
import { Telegrafo, POSICIONES as POSICIONES_TELEGRAFO } from './aula/telegrafo.js';
import type {
  CartaParseada,
  EstadoBuqueDTO,
  LoginResponse,
  ShipControlPayload,
  TelegrafoId,
  TickPayload,
} from '../shared/types.js';

interface AulaPayload {
  sesion: {
    id: number;
    nombre: string;
    descripcion: string | null;
    escenarioNombre: string;
    ownshipIndex: number;
  };
  carta: CartaParseada;
}

// ----- DOM refs --------------------------------------------------------------
const userBadge = el<HTMLSpanElement>('userBadge');
const titulo = el<HTMLHeadingElement>('sesionTitulo');
const ownshipBadge = el<HTMLSpanElement>('ownshipBadge');
const connBadge = el<HTMLSpanElement>('connBadge');
const loadingMsg = el<HTMLDivElement>('loadingMsg');
const canvas = el<HTMLCanvasElement>('cartaCanvas');

// Heading + turn rate + set course + rudder
const displayHeading = el<HTMLDivElement>('displayHeading');
const displayTurnRate = el<HTMLSpanElement>('displayTurnRate');
const inputSetCourse = el<HTMLInputElement>('inputSetCourse');
const btnSetCourseEnter = el<HTMLButtonElement>('btnSetCourseEnter');
const btnAutopilot = el<HTMLButtonElement>('btnAutopilot');
const displaySetCourse = el<HTMLSpanElement>('displaySetCourse');
const inputRudder = el<HTMLInputElement>('inputRudder');
const btnRudderPort = el<HTMLButtonElement>('btnRudderPort');
const btnRudderStbd = el<HTMLButtonElement>('btnRudderStbd');
const btnRudderCenter = el<HTMLButtonElement>('btnRudderCenter');

// Telégrafo
const telegrafoMount = el<HTMLDivElement>('telegrafoMount');
const displayVelObj = el<HTMLSpanElement>('displayVelObj');
const displayVelReal = el<HTMLSpanElement>('displayVelReal');

// LOG / Time
const displayDistance = el<HTMLSpanElement>('displayDistance');
const displayTime = el<HTMLSpanElement>('displayTime');
const displayUTC = el<HTMLSpanElement>('displayUTC');

// GPS
const displayLat = el<HTMLSpanElement>('displayLat');
const displayLon = el<HTMLSpanElement>('displayLon');
const displayGpsUtc = el<HTMLSpanElement>('displayGpsUtc');
const displayGpsSpeed = el<HTMLSpanElement>('displayGpsSpeed');
const displayGpsTrip = el<HTMLSpanElement>('displayGpsTrip');
const displayGpsCourse = el<HTMLSpanElement>('displayGpsCourse');

// ----- Estado --------------------------------------------------------------
let sesionId = 0;
let miOwnshipIndex = 0;
let cartaCache: CartaParseada | null = null;
let imagenCache: HTMLImageElement | null = null;
let ultimoTick: TickPayload | null = null;
let socket: Socket | null = null;
let telegrafo: Telegrafo | null = null;
let dialRudderCmd: Dial | null = null;
let dialRudderAngle: Dial | null = null;
let dialTurnRate: Dial | null = null;
let dialWindSpeed: Dial | null = null;
let dialWindDirection: Dial | null = null;

// Para no spamear el server con cada tecla, debounceamos los inputs numéricos.
let rudderDebounce: ReturnType<typeof setTimeout> | null = null;

// ----- Init ----------------------------------------------------------------
async function init(): Promise<void> {
  const meRes = await fetch('/api/auth/me', { credentials: 'include' });
  if (!meRes.ok) {
    location.href = '/login.html';
    return;
  }
  const { user } = (await meRes.json()) as LoginResponse;
  if (user.role !== 'alumno') {
    location.href = '/dashboard.html';
    return;
  }
  userBadge.textContent = `${user.nombre} (${user.role})`;

  const params = new URLSearchParams(location.search);
  sesionId = Number(params.get('sesion'));
  if (!Number.isFinite(sesionId) || sesionId <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  const res = await fetch(`/api/aula/${sesionId}`, { credentials: 'include' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    showError(err.error ?? 'No se pudo entrar a la sesión');
    return;
  }
  const { sesion, carta } = (await res.json()) as AulaPayload;
  miOwnshipIndex = sesion.ownshipIndex;

  titulo.textContent = sesion.nombre;
  ownshipBadge.textContent = `OS-${sesion.ownshipIndex}`;
  ownshipBadge.classList.add('badge-abierta');
  cartaCache = carta;

  const img = new Image();
  img.src = carta.rasterUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo cargar el PNG de la carta'));
  });
  imagenCache = img;
  loadingMsg.hidden = true;
  canvas.hidden = false;

  inicializarWidgets();
  cablearControles();
  conectarSocket();
  redraw();
}

function inicializarWidgets(): void {
  // Telégrafo vertical
  telegrafo = new Telegrafo(telegrafoMount, (id) => {
    enviarComando({ telegrafo: id });
  });

  // Diales
  dialRudderCmd = new Dial(el('dialRudderCmd'), {
    label: 'RUDDER COMMAND',
    unit: '°',
    min: -35,
    max: 35,
    ticks: 7,
  });
  dialRudderAngle = new Dial(el('dialRudderAngle'), {
    label: 'RUDDER ANGLE',
    unit: '°',
    min: -35,
    max: 35,
    ticks: 7,
  });
  dialTurnRate = new Dial(el('dialTurnRate'), {
    label: 'TURN RATE',
    unit: '°/min',
    min: -90,
    max: 90,
    ticks: 6,
  });
  dialWindSpeed = new Dial(el('dialWindSpeed'), {
    label: 'WIND SPEED',
    unit: 'kn',
    min: 0,
    max: 60,
    ticks: 6,
  });
  dialWindDirection = new Dial(el('dialWindDirection'), {
    label: 'WIND DIRECTION',
    unit: '°',
    min: 0,
    max: 360,
    ticks: 8,
    compass: true,
  });
}

function cablearControles(): void {
  // SET COURSE
  btnSetCourseEnter.addEventListener('click', () => {
    const v = clampDeg(Number(inputSetCourse.value));
    inputSetCourse.value = String(v);
    enviarComando({ setCourseDeg: v });
  });
  inputSetCourse.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSetCourseEnter.click();
  });

  // AUTOPILOT toggle
  btnAutopilot.addEventListener('click', () => {
    const ahora = ultimoMioOnly()?.autopilotOn ?? false;
    enviarComando({ autopilotOn: !ahora });
  });

  // RUDDER COMMAND con +/- y centrar
  btnRudderPort.addEventListener('click', () => aplicarRudder(-magnitudInputRudder()));
  btnRudderStbd.addEventListener('click', () => aplicarRudder(+magnitudInputRudder()));
  btnRudderCenter.addEventListener('click', () => {
    inputRudder.value = '0';
    aplicarRudder(0);
  });
  inputRudder.addEventListener('input', () => {
    if (rudderDebounce) clearTimeout(rudderDebounce);
    rudderDebounce = setTimeout(() => {
      const m = magnitudInputRudder();
      // Si el usuario ya seleccionó un lado, mantener el signo del valor actual.
      const actual = ultimoMioOnly()?.rudderCommandDeg ?? 0;
      const signo = actual < 0 ? -1 : 1;
      aplicarRudder(signo * m);
    }, 250);
  });
}

function aplicarRudder(deg: number): void {
  const clamped = Math.max(-35, Math.min(35, Math.round(deg)));
  enviarComando({ rudderCommandDeg: clamped });
}

function magnitudInputRudder(): number {
  const v = Math.abs(Number(inputRudder.value));
  return Number.isFinite(v) ? Math.max(0, Math.min(35, v)) : 0;
}

function clampDeg(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return ((Math.round(v) % 360) + 360) % 360;
}

function conectarSocket(): void {
  socket = io({ auth: { sesionId }, withCredentials: true });
  socket.on('connect', () => {
    connBadge.textContent = 'conectado';
    connBadge.className = 'badge badge-abierta';
  });
  socket.on('connect_error', (err) => {
    connBadge.textContent = 'error: ' + err.message;
    connBadge.className = 'badge badge-finalizada';
  });
  socket.on('disconnect', () => {
    connBadge.textContent = 'desconectado';
    connBadge.className = 'badge badge-preparada';
  });
  socket.on('world:tick', (payload: TickPayload) => {
    ultimoTick = payload;
    actualizarWidgets();
    redraw();
  });
  socket.on('session:closed', () => {
    alert('El profesor cerró la sesión.');
    location.href = '/dashboard.html';
  });
}

function enviarComando(payload: ShipControlPayload): void {
  socket?.emit('ship:control', payload);
}

function ultimoMioOnly(): EstadoBuqueDTO | null {
  if (!ultimoTick) return null;
  return ultimoTick.buques.find((b) => b.ownshipIndex === miOwnshipIndex) ?? null;
}

function actualizarWidgets(): void {
  if (!ultimoTick) return;
  const mio = ultimoMioOnly();
  if (!mio) return;

  // Heading + turn rate
  displayHeading.textContent = mio.headingDeg.toFixed(1).padStart(5, '0');
  displayTurnRate.textContent = `${mio.turnRateDegPerMin >= 0 ? '+' : ''}${mio.turnRateDegPerMin.toFixed(1)}°/min`;

  // Set course + autopiloto
  displaySetCourse.textContent = `${Math.round(mio.setCourseDeg).toString().padStart(3, '0')}°`;
  btnAutopilot.classList.toggle('active', mio.autopilotOn);
  btnAutopilot.textContent = mio.autopilotOn ? 'AUTO ON' : 'AUTO OFF';
  // Si no estamos editando el input, mantenerlo sincronizado con el server.
  if (document.activeElement !== inputSetCourse) {
    inputSetCourse.value = String(Math.round(mio.setCourseDeg));
  }

  // Rudder: si autopiloto está on, deshabilitamos los controles manuales.
  inputRudder.disabled = mio.autopilotOn;
  btnRudderPort.disabled = mio.autopilotOn;
  btnRudderStbd.disabled = mio.autopilotOn;
  btnRudderCenter.disabled = mio.autopilotOn;
  if (document.activeElement !== inputRudder) {
    inputRudder.value = String(Math.abs(Math.round(mio.rudderCommandDeg)));
  }

  // Telégrafo: si el server tiene una posición distinta a la nuestra (ej. otra
  // ventana del alumno) la sincronizamos.
  if (telegrafo && POSICIONES_TELEGRAFO.find((p) => p.id === mio.telegrafo)) {
    telegrafo.set(mio.telegrafo as TelegrafoId, false);
  }

  // Velocidad ordenada y real
  displayVelObj.textContent = `${mio.velObjetivoKn.toFixed(1)} kn`;
  displayVelReal.textContent = `${mio.velocidadKn.toFixed(1)} kn`;

  // LOG / TIME
  displayDistance.textContent = `${mio.distanceTotalNm.toFixed(2)} nm`;
  const segundos = Math.max(0, Math.floor((Date.now() - mio.tripStartedAt) / 1000));
  displayTime.textContent = formatHMS(segundos);
  displayUTC.textContent = formatUTC(ultimoTick.ambiente.utcTimestamp);

  // GPS
  displayLat.textContent = formatDMS(mio.lat, true);
  displayLon.textContent = formatDMS(mio.lon, false);
  displayGpsUtc.textContent = formatUTC(ultimoTick.ambiente.utcTimestamp);
  displayGpsSpeed.textContent = `${mio.velocidadKn.toFixed(1)} kt`;
  displayGpsTrip.textContent = `${mio.distanceTotalNm.toFixed(2)} nm`;
  displayGpsCourse.textContent = `${mio.headingDeg.toFixed(1)}°`;

  // Diales
  dialRudderCmd?.setValue(mio.rudderCommandDeg);
  dialRudderAngle?.setValue(mio.rudderAngleDeg);
  dialTurnRate?.setValue(mio.turnRateDegPerMin);
  dialWindSpeed?.setValue(ultimoTick.ambiente.windSpeedKn);
  dialWindDirection?.setValue(ultimoTick.ambiente.windDirectionDeg);
}

// ----- Render del barco sobre la carta ---------------------------------------
function redraw(): void {
  if (!cartaCache || !imagenCache) return;
  const img = imagenCache;
  const dpr = window.devicePixelRatio || 1;
  const containerWidth = canvas.parentElement!.clientWidth - 4;
  const containerHeight = canvas.parentElement!.clientHeight - 4;
  const escala = Math.min(
    1,
    containerWidth / img.naturalWidth,
    containerHeight / img.naturalHeight,
  );
  const dispW = Math.floor(img.naturalWidth * escala);
  const dispH = Math.floor(img.naturalHeight * escala);
  canvas.style.width = `${dispW}px`;
  canvas.style.height = `${dispH}px`;
  canvas.width = Math.floor(dispW * dpr);
  canvas.height = Math.floor(dispH * dpr);

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr * escala, 0, 0, dpr * escala, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, 0, 0);

  if (ultimoTick) {
    for (const b of ultimoTick.buques) {
      dibujarBuque(ctx, escala, b, b.ownshipIndex === miOwnshipIndex);
    }
  }
}

function dibujarBuque(
  ctx: CanvasRenderingContext2D,
  escala: number,
  b: EstadoBuqueDTO,
  esPropio: boolean,
): void {
  if (!cartaCache) return;
  const [px, py] = latLonToPx(b.lat, b.lon);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate((b.headingDeg * Math.PI) / 180);
  const r = 8 / escala;
  ctx.fillStyle = esPropio ? 'rgba(0, 220, 140, 0.95)' : 'rgba(255, 220, 60, 0.9)';
  ctx.strokeStyle = esPropio ? '#003322' : '#332200';
  ctx.lineWidth = 1.5 / escala;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.6);
  ctx.lineTo(r, r);
  ctx.lineTo(-r, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (Math.abs(b.velocidadKn) > 0.1) {
    const largo = Math.min(60, Math.abs(b.velocidadKn) * 2) / escala;
    const sentido = b.velocidadKn >= 0 ? -1 : 1;
    ctx.strokeStyle = esPropio ? 'rgba(0, 220, 140, 0.7)' : 'rgba(255, 220, 60, 0.6)';
    ctx.lineWidth = 1.5 / escala;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, sentido * largo);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = esPropio ? 'rgba(0, 220, 140, 1)' : 'rgba(255, 220, 60, 0.9)';
  ctx.font = `${12 / escala}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`OS-${b.ownshipIndex}`, px, py + 12 / escala);
}

function latLonToPx(lat: number, lon: number): [number, number] {
  if (!cartaCache) return [0, 0];
  const { esquinaNW, esquinaSE } = cartaCache;
  const fx = (lon - esquinaNW.lon) / (esquinaSE.lon - esquinaNW.lon);
  const fy = (esquinaNW.lat - lat) / (esquinaNW.lat - esquinaSE.lat);
  const px = esquinaNW.px + fx * (esquinaSE.px - esquinaNW.px);
  const py = esquinaNW.py + fy * (esquinaSE.py - esquinaNW.py);
  return [px, py];
}

// ----- Helpers ---------------------------------------------------------------
function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Falta #${id} en el HTML`);
  return e as T;
}

function showError(msg: string): void {
  loadingMsg.textContent = msg;
  loadingMsg.classList.remove('placeholder');
  loadingMsg.classList.add('auth-error');
}

function formatDMS(coord: number, esLat: boolean): string {
  const abs = Math.abs(coord);
  const grados = Math.floor(abs);
  const minutosFloat = (abs - grados) * 60;
  const minutos = minutosFloat.toFixed(3);
  const sufijo = esLat ? (coord >= 0 ? 'N' : 'S') : coord >= 0 ? 'E' : 'W';
  return `${grados}°${minutos.padStart(6, '0')}'${sufijo}`;
}

function formatHMS(segundos: number): string {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatUTC(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

window.addEventListener('resize', () => {
  redraw();
  telegrafo?.refresh();
});
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
