import { io, type Socket } from 'socket.io-client';
import { PPI, ESCALAS_NM, type EscalaNm, type PPIMode } from './radar/ppi.js';
import type {
  CartaParseada,
  EstadoBuqueDTO,
  LoginResponse,
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

const titulo = document.querySelector('h1') as HTMLHeadingElement;
const ownshipBadge = document.getElementById('ownshipBadge') as HTMLSpanElement;
const connBadge = document.getElementById('connBadge') as HTMLSpanElement;
const loadingMsg = document.getElementById('loadingMsg') as HTMLDivElement;
const canvas = document.getElementById('ppiCanvas') as HTMLCanvasElement;
const rangeGrid = document.getElementById('rangeGrid') as HTMLDivElement;
const modeNorthBtn = document.getElementById('modeNorth') as HTMLButtonElement;
const modeHeadBtn = document.getElementById('modeHead') as HTMLButtonElement;
const hdgVal = document.getElementById('hdgVal') as HTMLSpanElement;
const spdVal = document.getElementById('spdVal') as HTMLSpanElement;
const posLatVal = document.getElementById('posLatVal') as HTMLSpanElement;
const posLonVal = document.getElementById('posLonVal') as HTMLSpanElement;

let sesionId = 0;
let miOwnshipIndex = 0;
let cartaCache: CartaParseada | null = null;
let ppi: PPI | null = null;
let socket: Socket | null = null;
let ultimoTick: TickPayload | null = null;

const config = {
  escalaNm: 6 as EscalaNm,
  mode: 'NORTH_UP' as PPIMode,
};

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

  const params = new URLSearchParams(location.search);
  sesionId = Number(params.get('sesion'));
  if (!Number.isFinite(sesionId) || sesionId <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  const res = await fetch(`/api/aula/${sesionId}`, { credentials: 'include' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    showError(err.error ?? 'No se pudo entrar al radar');
    return;
  }
  const { sesion, carta } = (await res.json()) as AulaPayload;
  miOwnshipIndex = sesion.ownshipIndex;
  cartaCache = carta;

  titulo.firstChild!.nodeValue = `RADAR PPI — ${sesion.nombre} `;
  ownshipBadge.textContent = `OS-${sesion.ownshipIndex}`;
  ownshipBadge.classList.add('badge-abierta');

  loadingMsg.hidden = true;
  canvas.hidden = false;
  ppi = new PPI(canvas);
  ppi.resize();

  construirControlesEscala();
  cablearControles();
  conectarSocket();
  loop();
}

function construirControlesEscala(): void {
  rangeGrid.innerHTML = '';
  for (const escala of ESCALAS_NM) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-sm range-btn';
    btn.textContent = escala < 1 ? escala.toFixed(2) : `${escala}`;
    btn.dataset.value = String(escala);
    if (escala === config.escalaNm) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (config.escalaNm === escala) return;
      config.escalaNm = escala;
      // Los ecos viejos están dibujados a la escala anterior; los borramos
      // para que solo se vean los nuevos a la nueva escala.
      ppi?.clearEchoes();
      [...rangeGrid.querySelectorAll('.range-btn')].forEach((b) =>
        b.classList.toggle('active', (b as HTMLElement).dataset.value === String(escala)),
      );
    });
    rangeGrid.appendChild(btn);
  }
}

function cablearControles(): void {
  modeNorthBtn.addEventListener('click', () => {
    if (config.mode === 'NORTH_UP') return;
    config.mode = 'NORTH_UP';
    ppi?.clearEchoes();
    modeNorthBtn.classList.add('active');
    modeHeadBtn.classList.remove('active');
  });
  modeHeadBtn.addEventListener('click', () => {
    if (config.mode === 'HEAD_UP') return;
    config.mode = 'HEAD_UP';
    ppi?.clearEchoes();
    modeHeadBtn.classList.add('active');
    modeNorthBtn.classList.remove('active');
  });
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
    actualizarStatus();
  });
  socket.on('session:closed', () => {
    alert('El profesor cerró la sesión.');
    window.close();
  });
}

function actualizarStatus(): void {
  const mio = miBuque();
  if (!mio) return;
  hdgVal.textContent = `${mio.headingDeg.toFixed(1)}°`;
  spdVal.textContent = `${mio.velocidadKn.toFixed(1)} kn`;
  posLatVal.textContent = formatDMS(mio.lat, true);
  posLonVal.textContent = formatDMS(mio.lon, false);
}

function miBuque(): EstadoBuqueDTO | null {
  if (!ultimoTick) return null;
  return ultimoTick.buques.find((b) => b.ownshipIndex === miOwnshipIndex) ?? null;
}

function otrosBuques(): EstadoBuqueDTO[] {
  if (!ultimoTick) return [];
  return ultimoTick.buques.filter((b) => b.ownshipIndex !== miOwnshipIndex);
}

// Loop de render a 60 FPS para mantener el barrido suave (cuando lo agreguemos en 4.3).
function loop(): void {
  if (ppi) {
    ppi.draw(miBuque(), otrosBuques(), cartaCache, config);
  }
  requestAnimationFrame(loop);
}

function showError(msg: string): void {
  loadingMsg.textContent = msg;
  loadingMsg.classList.remove('placeholder');
  loadingMsg.classList.add('auth-error');
}

function formatDMS(coord: number, esLat: boolean): string {
  const abs = Math.abs(coord);
  const grados = Math.floor(abs);
  const minutos = ((abs - grados) * 60).toFixed(3);
  const sufijo = esLat ? (coord >= 0 ? 'N' : 'S') : coord >= 0 ? 'E' : 'W';
  return `${grados}°${minutos.padStart(6, '0')}'${sufijo}`;
}

window.addEventListener('resize', () => ppi?.resize());
document.getElementById('logoutBtn')!.addEventListener('click', () => window.close());

void init();
