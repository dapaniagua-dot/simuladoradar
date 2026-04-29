import { io, type Socket } from 'socket.io-client';
import { PPI, ESCALAS_NM, type EscalaNm, type PPIMode } from './radar/ppi.js';
import { ArpaTracker, type DatosArpa } from './radar/arpa.js';
import { latLonAMillasRel } from './radar/coords.js';
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

type EblMode = 'TRUE' | 'RELATIVE';

const config = {
  escalaNm: 6 as EscalaNm,
  mode: 'NORTH_UP' as PPIMode,
  eblActive: false,
  eblBearingTrue: 0,
  vrmActive: false,
  vrmRangeNm: 1,
};

let eblMode: EblMode = 'TRUE';

const arpa = new ArpaTracker();
let arpaAcquireMode = false; // true = el siguiente click adquiere un blanco
let arpaTargets: DatosArpa[] = [];

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

  cablearEBL();
  cablearVRM();
  cablearARPA();
}

function cablearARPA(): void {
  const btnAcquire = document.getElementById('btnArpaAcquire') as HTMLButtonElement;
  const btnCeaseAll = document.getElementById('btnArpaCeaseAll') as HTMLButtonElement;
  const canvas = document.getElementById('ppiCanvas') as HTMLCanvasElement;

  btnAcquire.addEventListener('click', () => {
    arpaAcquireMode = !arpaAcquireMode;
    btnAcquire.classList.toggle('active', arpaAcquireMode);
    btnAcquire.textContent = arpaAcquireMode ? 'CLICK ECO ROJO…' : 'ACQUIRE';
    canvas.style.cursor = arpaAcquireMode ? 'crosshair' : '';
  });

  btnCeaseAll.addEventListener('click', () => {
    arpa.ceaseAll();
    refrescarListaArpa();
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!arpaAcquireMode) return;
    const mio = miBuque();
    if (!mio) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = e.clientY - rect.top - rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2 - 30;
    const pixelsPorMilla = radius / config.escalaNm;

    // Convertir el click a (xE, yN) millas relativas al barco propio.
    let bearingPantalla = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    bearingPantalla = ((bearingPantalla % 360) + 360) % 360;
    let bearingTrue = bearingPantalla;
    if (config.mode === 'HEAD_UP') {
      bearingTrue = (bearingPantalla + mio.headingDeg + 360) % 360;
    }
    const distNm = Math.hypot(dx, dy) / pixelsPorMilla;
    const xE = Math.sin((bearingTrue * Math.PI) / 180) * distNm;
    const yN = Math.cos((bearingTrue * Math.PI) / 180) * distNm;

    // Buscar el OwnShip más cercano al click (umbral 0.5 nm).
    let mejor: { idx: number; dist: number } | null = null;
    for (const b of otrosBuques()) {
      const rel = latLonAMillasRel(b.lat, b.lon, mio.lat, mio.lon);
      const d = Math.hypot(rel.xE - xE, rel.yN - yN);
      if (d < 0.5 && (!mejor || d < mejor.dist)) {
        mejor = { idx: b.ownshipIndex, dist: d };
      }
    }
    if (mejor) {
      arpa.adquirirOwnship(mejor.idx);
      refrescarListaArpa();
    }

    // Salir del modo acquire después de un click (success o no).
    arpaAcquireMode = false;
    btnAcquire.classList.remove('active');
    btnAcquire.textContent = 'ACQUIRE';
    canvas.style.cursor = '';
  });
}

function refrescarListaArpa(): void {
  const list = document.getElementById('arpaList') as HTMLDivElement;
  if (arpaTargets.length === 0) {
    list.innerHTML = `<p class="placeholder ebl-tip">Sin blancos. Click ACQUIRE y después click sobre un eco rojo del PPI.</p>`;
    return;
  }
  list.innerHTML = '';
  for (const t of arpaTargets) {
    const peligro = t.cpaNm !== null && t.cpaNm < 0.5 && t.tcpaMin !== null && t.tcpaMin > 0;
    const row = document.createElement('div');
    row.className = `arpa-row${peligro ? ' arpa-peligro' : ''}`;
    const courseStr = Number.isFinite(t.courseDeg) ? `${t.courseDeg.toFixed(0)}°` : '—';
    const cpaStr = t.cpaNm !== null ? `${t.cpaNm.toFixed(2)} nm` : '—';
    const tcpaStr = t.tcpaMin !== null ? `${t.tcpaMin.toFixed(1)} min` : '—';
    row.innerHTML = `
      <div class="arpa-row-head">
        <strong>${t.id}</strong>
        <button type="button" class="btn-cease" data-id="${t.id}">×</button>
      </div>
      <div class="arpa-row-body">
        <span>BRG ${t.bearingTrue.toFixed(0)}°T</span>
        <span>RNG ${t.rangeNm.toFixed(2)}nm</span>
        <span>CRS ${courseStr}</span>
        <span>SPD ${t.speedKn.toFixed(1)}kn</span>
        <span>CPA ${cpaStr}</span>
        <span>TCPA ${tcpaStr}</span>
      </div>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('.btn-cease').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.id!;
      arpa.ceaseTrack(id);
      refrescarListaArpa();
    });
  });
}

function cablearVRM(): void {
  const btnVrm = document.getElementById('btnVrm') as HTMLButtonElement;
  const vrmControls = document.getElementById('vrmControls') as HTMLDivElement;
  const vrmRangeInput = document.getElementById('vrmRangeInput') as HTMLInputElement;

  btnVrm.addEventListener('click', () => {
    config.vrmActive = !config.vrmActive;
    btnVrm.classList.toggle('active', config.vrmActive);
    btnVrm.textContent = config.vrmActive ? 'VRM ON' : 'VRM OFF';
    vrmControls.hidden = !config.vrmActive;
  });

  vrmRangeInput.addEventListener('input', () => {
    const v = Number(vrmRangeInput.value);
    if (!Number.isFinite(v) || v <= 0) return;
    config.vrmRangeNm = Math.min(48, v);
  });

  // Click + drag en el canvas: el radio del VRM = distancia del cursor al
  // centro del PPI, convertida a millas.
  const canvas = document.getElementById('ppiCanvas') as HTMLCanvasElement;
  let dragging = false;
  const onMove = (clientX: number, clientY: number): void => {
    if (!config.vrmActive) return;
    const rect = canvas.getBoundingClientRect();
    const dx = clientX - rect.left - rect.width / 2;
    const dy = clientY - rect.top - rect.height / 2;
    const distPx = Math.hypot(dx, dy);
    if (distPx < 6) return;
    // pixelsPorMilla en el cliente: el PPI usa radius = (size/2 - 30).
    // Replicamos el cálculo aquí para no acoplarnos a la clase PPI.
    const radius = Math.min(rect.width, rect.height) / 2 - 30;
    const pixelsPorMilla = radius / config.escalaNm;
    if (pixelsPorMilla <= 0) return;
    const rangeNm = distPx / pixelsPorMilla;
    config.vrmRangeNm = Math.max(0.01, Math.min(config.escalaNm, rangeNm));
  };

  canvas.addEventListener('mousedown', (e) => {
    if (!config.vrmActive) return;
    // Si EBL también está activo, EBL gana en este click (ya tiene su propio
    // listener). Una solución sería un mode picker, pero para MVP lo dejamos
    // así: el handler del EBL se dispara primero por orden de cablear.
    dragging = true;
    onMove(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    onMove(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });
}

function cablearEBL(): void {
  const btnEbl = document.getElementById('btnEbl') as HTMLButtonElement;
  const eblControls = document.getElementById('eblControls') as HTMLDivElement;
  const eblBearingInput = document.getElementById('eblBearingInput') as HTMLInputElement;
  const eblModeTrue = document.getElementById('eblModeTrue') as HTMLButtonElement;
  const eblModeRelative = document.getElementById('eblModeRelative') as HTMLButtonElement;

  btnEbl.addEventListener('click', () => {
    config.eblActive = !config.eblActive;
    btnEbl.classList.toggle('active', config.eblActive);
    btnEbl.textContent = config.eblActive ? 'EBL ON' : 'EBL OFF';
    eblControls.hidden = !config.eblActive;
  });

  eblBearingInput.addEventListener('input', () => {
    const v = Number(eblBearingInput.value);
    if (!Number.isFinite(v)) return;
    const userBearing = ((v % 360) + 360) % 360;
    config.eblBearingTrue = eblMode === 'TRUE' ? userBearing : userBearingToTrue(userBearing);
  });

  eblModeTrue.addEventListener('click', () => {
    eblMode = 'TRUE';
    eblModeTrue.classList.add('active');
    eblModeRelative.classList.remove('active');
  });
  eblModeRelative.addEventListener('click', () => {
    eblMode = 'RELATIVE';
    eblModeRelative.classList.add('active');
    eblModeTrue.classList.remove('active');
  });

  // Click + drag en el canvas del PPI para apuntar el EBL al cursor.
  // Los radares reales usan trackball; con mouse esto es la traducción natural.
  const canvas = document.getElementById('ppiCanvas') as HTMLCanvasElement;
  let dragging = false;
  const onMove = (clientX: number, clientY: number): void => {
    if (!config.eblActive) return;
    const rect = canvas.getBoundingClientRect();
    const dx = clientX - rect.left - rect.width / 2;
    const dy = clientY - rect.top - rect.height / 2;
    if (Math.hypot(dx, dy) < 8) return; // ignorar clicks muy cerca del centro
    // ángulo de pantalla: 0 = arriba, sentido horario, 0..360
    let bearingPantalla = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    bearingPantalla = ((bearingPantalla % 360) + 360) % 360;
    // En Head Up, "arriba en pantalla" representa la proa (heading), así que
    // hay que sumar el heading actual para obtener el bearing TRUE.
    let bearingTrue = bearingPantalla;
    if (config.mode === 'HEAD_UP') {
      const heading = miBuque()?.headingDeg ?? 0;
      bearingTrue = (bearingPantalla + heading + 360) % 360;
    }
    config.eblBearingTrue = bearingTrue;
  };

  canvas.addEventListener('mousedown', (e) => {
    if (!config.eblActive) return;
    dragging = true;
    onMove(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    onMove(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });
}

// Convierte bearing relativo (0 = proa) a TRUE (0 = norte) usando el heading actual.
function userBearingToTrue(bearingRel: number): number {
  const heading = miBuque()?.headingDeg ?? 0;
  return ((bearingRel + heading) % 360 + 360) % 360;
}

function trueAUserBearing(bearingTrue: number, mode: EblMode): number {
  if (mode === 'TRUE') return bearingTrue;
  const heading = miBuque()?.headingDeg ?? 0;
  return ((bearingTrue - heading) % 360 + 360) % 360;
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
    arpa.procesarTick(payload.t, payload.buques);
    const mio = miBuque();
    if (mio) {
      arpaTargets = arpa.evaluar(mio, payload.buques);
    }
    actualizarStatus();
    refrescarListaArpa();
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

  // Actualizar el display del EBL si está activo.
  if (config.eblActive) {
    const bearingDisplay = document.getElementById('eblBearingDisplay') as HTMLSpanElement | null;
    const bearingInput = document.getElementById('eblBearingInput') as HTMLInputElement | null;
    const userBearing = trueAUserBearing(config.eblBearingTrue, eblMode);
    if (bearingDisplay) {
      const sufijo = eblMode === 'TRUE' ? 'T' : 'R';
      bearingDisplay.textContent = `${userBearing.toFixed(1).padStart(5, '0')}° ${sufijo}`;
    }
    // No pisamos el input mientras el usuario está escribiendo.
    if (bearingInput && document.activeElement !== bearingInput) {
      bearingInput.value = userBearing.toFixed(1);
    }
  }

  // Actualizar el display del VRM si está activo.
  if (config.vrmActive) {
    const rangeDisplay = document.getElementById('vrmRangeDisplay') as HTMLSpanElement | null;
    const rangeInput = document.getElementById('vrmRangeInput') as HTMLInputElement | null;
    if (rangeDisplay) {
      rangeDisplay.textContent = `${config.vrmRangeNm.toFixed(2)} nm`;
    }
    if (rangeInput && document.activeElement !== rangeInput) {
      rangeInput.value = config.vrmRangeNm.toFixed(2);
    }
  }
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
    ppi.draw(miBuque(), otrosBuques(), cartaCache, config, arpaTargets);
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
