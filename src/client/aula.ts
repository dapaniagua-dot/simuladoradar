import { io, type Socket } from 'socket.io-client';
import type {
  CartaParseada,
  EstadoBuqueDTO,
  LoginResponse,
  PosicionTelegrafo,
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

// Telégrafo: las posiciones que el alumno puede tocar.
const POSICIONES_TELEGRAFO: PosicionTelegrafo[] = [
  { id: 'FAH',  nombre: 'Full Ahead',       velObjetivoKn: 0 },
  { id: 'HAH',  nombre: 'Half Ahead',       velObjetivoKn: 0 },
  { id: 'SAH',  nombre: 'Slow Ahead',       velObjetivoKn: 0 },
  { id: 'DSAH', nombre: 'Dead Slow Ahead',  velObjetivoKn: 0 },
  { id: 'STOP', nombre: 'Stop',             velObjetivoKn: 0 },
  { id: 'DSAS', nombre: 'Dead Slow Astern', velObjetivoKn: 0 },
  { id: 'SAS',  nombre: 'Slow Astern',      velObjetivoKn: 0 },
  { id: 'HAS',  nombre: 'Half Astern',      velObjetivoKn: 0 },
  { id: 'FAS',  nombre: 'Full Astern',      velObjetivoKn: 0 },
];

const userBadge = document.getElementById('userBadge') as HTMLSpanElement;
const titulo = document.getElementById('sesionTitulo') as HTMLHeadingElement;
const ownshipBadge = document.getElementById('ownshipBadge') as HTMLSpanElement;
const connBadge = document.getElementById('connBadge') as HTMLSpanElement;
const loadingMsg = document.getElementById('loadingMsg') as HTMLDivElement;
const canvas = document.getElementById('cartaCanvas') as HTMLCanvasElement;
const telegrafoBotones = document.getElementById('telegrafoBotones') as HTMLDivElement;
const rudderSlider = document.getElementById('rudderSlider') as HTMLInputElement;
const rudderValor = document.getElementById('rudderValor') as HTMLSpanElement;
const rudderCenter = document.getElementById('rudderCenter') as HTMLButtonElement;
const hudHeading = document.getElementById('hudHeading') as HTMLSpanElement;
const hudVel = document.getElementById('hudVel') as HTMLSpanElement;
const hudVelObj = document.getElementById('hudVelObj') as HTMLSpanElement;
const hudPos = document.getElementById('hudPos') as HTMLSpanElement;

let sesionId = 0;
let miOwnshipIndex = 0;
let cartaCache: CartaParseada | null = null;
let imagenCache: HTMLImageElement | null = null;
let ultimoTick: TickPayload | null = null;
let socket: Socket | null = null;
let telegrafoActual: TelegrafoId = 'STOP';

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

  construirTelegrafo();
  cablearTimon();
  conectarSocket();
  redraw();
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
    actualizarHUD();
    redraw();
  });
  socket.on('session:closed', () => {
    alert('El profesor cerró la sesión.');
    location.href = '/dashboard.html';
  });
}

function construirTelegrafo(): void {
  telegrafoBotones.innerHTML = '';
  for (const pos of POSICIONES_TELEGRAFO) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'telegrafo-btn';
    btn.dataset.id = pos.id;
    btn.innerHTML = `<strong>${pos.id}</strong><span>${pos.nombre}</span>`;
    if (pos.id === telegrafoActual) btn.classList.add('active');
    btn.addEventListener('click', () => {
      telegrafoActual = pos.id;
      // Actualizar visualmente apenas se toca; el server confirma con el próximo tick.
      [...telegrafoBotones.querySelectorAll('.telegrafo-btn')].forEach((el) =>
        el.classList.toggle('active', (el as HTMLElement).dataset.id === pos.id),
      );
      enviarComando({ telegrafo: pos.id });
    });
    telegrafoBotones.appendChild(btn);
  }
}

function cablearTimon(): void {
  rudderSlider.addEventListener('input', () => {
    const v = Number(rudderSlider.value);
    rudderValor.textContent = `${v}°`;
    enviarComando({ rudderDeg: v });
  });
  rudderCenter.addEventListener('click', () => {
    rudderSlider.value = '0';
    rudderValor.textContent = '0°';
    enviarComando({ rudderDeg: 0 });
  });
}

function enviarComando(payload: ShipControlPayload): void {
  socket?.emit('ship:control', payload);
}

function actualizarHUD(): void {
  if (!ultimoTick) return;
  const mio = ultimoTick.buques.find((b) => b.ownshipIndex === miOwnshipIndex);
  if (!mio) return;
  hudHeading.textContent = `${mio.headingDeg.toFixed(0)}°`;
  hudVel.textContent = `${mio.velocidadKn.toFixed(1)} kn`;
  hudVelObj.textContent = `${mio.velObjetivoKn.toFixed(1)} kn`;
  hudPos.textContent = formatCoord(mio.lat, mio.lon);
}

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

  // Dibujar todos los buques sobre la carta. El propio se resalta.
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
  // Heading: 0 = norte = arriba. En canvas, "arriba" es -Y.
  // Rotación de canvas crece sentido horario, igual que el rumbo náutico.
  ctx.rotate((b.headingDeg * Math.PI) / 180);

  // Tamaño del símbolo (se mantiene legible a cualquier escala).
  const r = 8 / escala;

  // Triángulo apuntando al norte (que con la rotación apunta al heading).
  ctx.fillStyle = esPropio ? 'rgba(0, 220, 140, 0.95)' : 'rgba(255, 220, 60, 0.9)';
  ctx.strokeStyle = esPropio ? '#003322' : '#332200';
  ctx.lineWidth = 1.5 / escala;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.6);   // Proa
  ctx.lineTo(r, r);          // Popa estribor
  ctx.lineTo(-r, r);         // Popa babor
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Vector de velocidad (línea desde el centro hacia adelante).
  if (Math.abs(b.velocidadKn) > 0.1) {
    const largo = Math.min(60, Math.abs(b.velocidadKn) * 2) / escala;
    const sentido = b.velocidadKn >= 0 ? -1 : 1; // hacia adelante o atrás
    ctx.strokeStyle = esPropio ? 'rgba(0, 220, 140, 0.7)' : 'rgba(255, 220, 60, 0.6)';
    ctx.lineWidth = 1.5 / escala;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, sentido * largo);
    ctx.stroke();
  }

  ctx.restore();

  // Etiqueta debajo del buque
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

function showError(msg: string): void {
  loadingMsg.textContent = msg;
  loadingMsg.classList.remove('placeholder');
  loadingMsg.classList.add('auth-error');
}

function formatCoord(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns} ${Math.abs(lon).toFixed(4)}°${ew}`;
}

window.addEventListener('resize', redraw);
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
