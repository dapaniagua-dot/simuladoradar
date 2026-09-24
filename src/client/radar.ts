import { io, type Socket } from 'socket.io-client';
import { PPI, ESCALAS_NM, ANILLOS_NM, esPeligroso, type PPIConfig, type PPIMode } from './radar/ppi.js';
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
  observador?: { alumnoNombre: string };
}

// Lo que el radar del alumno publica para que el profesor lo vea igual.
interface EstadoRadar {
  config: PPIConfig;
  arpa: number[]; // ownshipIndex de los blancos adquiridos
}

const titulo = document.querySelector('h1') as HTMLHeadingElement;
const ownshipBadge = el<HTMLSpanElement>('ownshipBadge');
const connBadge = el<HTMLSpanElement>('connBadge');
const loadingMsg = el<HTMLDivElement>('loadingMsg');
const canvas = el<HTMLCanvasElement>('ppiCanvas');

let sesionId = 0;
let miOwnshipIndex = 0;
let cartaCache: CartaParseada | null = null;
let ppi: PPI | null = null;
let socket: Socket | null = null;
let ultimoTick: TickPayload | null = null;
// Modo observador: el profesor ve el radar de un alumno ("Show Radar" del
// Melipal), con la configuración que el alumno tiene en ese momento.
let observando = false;

const config: PPIConfig = {
  escalaNm: 6,
  mode: 'NORTH_UP',
  courseUpDeg: 0,
  ebl: [{ activa: false, bearingTrue: 0 }, { activa: false, bearingTrue: 45 }],
  vrm: [{ activa: false, rangoNm: 1 }, { activa: false, rangoNm: 2 }],
  anillos: true,
  marcaProa: true,
  marcaPopa: false,
  escalaMarcaciones: true,
  lineaBarrido: true,
  colorNoche: false,
  transmitiendo: true,
  ganancia: 75,
  sintonia: 76,
  mar: 50,
  autoClutter: false,
  arpaVisible: true,
  vector: 'TRUE',
  vectorMin: 6,
  cpaLimiteNm: 2,
  tcpaLimiteMin: 15,
  mostrarLimiteCpa: false,
};

// Rango de cada límite ajustable con los botones - / +.
const LIMITES = {
  vectorMin: { paso: 1, min: 1, max: 30, decimales: 0 },
  cpaLimiteNm: { paso: 0.1, min: 0.1, max: 5, decimales: 1 },
  tcpaLimiteMin: { paso: 1, min: 1, max: 60, decimales: 0 },
} as const;
type Limite = keyof typeof LIMITES;

type Marca = { tipo: 'ebl' | 'vrm'; i: 0 | 1 };
// La EBL/VRM que se mueve al arrastrar sobre el PPI (la última encendida).
let marcaSeleccionada: Marca | null = null;
type ModoClick = 'normal' | 'adquirir' | 'cesar';
let modoClick: ModoClick = 'normal';

const arpa = new ArpaTracker();
let arpaTargets: DatosArpa[] = [];

// Alarmas: la de colisión se reconoce con un click (deja de titilar) hasta
// que la situación se normaliza; "new target" se enciende unos segundos.
let colisionReconocida = false;
let nuevoBlancoHasta = 0;
let blancoPerdido = false;

async function init(): Promise<void> {
  const meRes = await fetch('/api/auth/me', { credentials: 'include' });
  if (!meRes.ok) {
    location.href = '/login.html';
    return;
  }
  const { user } = (await meRes.json()) as LoginResponse;
  const params = new URLSearchParams(location.search);
  observando = user.role !== 'alumno' && params.get('observar') !== null;
  if (user.role !== 'alumno' && !observando) {
    location.href = '/dashboard.html';
    return;
  }

  // Embebido dentro del aula: el aula ya tiene su barra superior y el botón
  // "Cerrar" (window.close) no aplica a un iframe, así que se ocultan.
  if (params.get('embebido') === '1') document.body.classList.add('embebido');
  sesionId = Number(params.get('sesion'));
  if (!Number.isFinite(sesionId) || sesionId <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  const consulta = observando ? `?observar=${Number(params.get('observar'))}` : '';
  const res = await fetch(`/api/aula/${sesionId}${consulta}`, { credentials: 'include' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    showError(err.error ?? 'No se pudo entrar al radar');
    return;
  }
  const { sesion, carta, observador } = (await res.json()) as AulaPayload;
  miOwnshipIndex = sesion.ownshipIndex;
  cartaCache = carta;

  titulo.firstChild!.nodeValue = observador
    ? `RADAR DE ${observador.alumnoNombre.toUpperCase()} (solo lectura) — ${sesion.nombre} `
    : `RADAR PPI — ${sesion.nombre} `;
  if (observando) {
    document.body.classList.add('observando');
    document.title = `Radar OS-${sesion.ownshipIndex} — ${observador?.alumnoNombre ?? ''}`;
  }
  ownshipBadge.textContent = `OS-${sesion.ownshipIndex}`;
  ownshipBadge.classList.add('badge-abierta');

  loadingMsg.hidden = true;
  canvas.hidden = false;
  ppi = new PPI(canvas);
  ppi.resize();

  cablearControles();
  cablearPPI();
  refrescarPanel();
  conectarSocket();
  loop();
}

// ----- Panel de control -------------------------------------------------------
function cablearControles(): void {
  // RANGE + / -
  el('rangeMas').addEventListener('click', () => cambiarEscala(+1));
  el('rangeMenos').addEventListener('click', () => cambiarEscala(-1));

  // Modo de presentación
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.rb-modo')) {
    btn.addEventListener('click', () => {
      config.mode = btn.dataset.modo as PPIMode;
      // Course Up fija "arriba" en el rumbo del momento en que se elige.
      if (config.mode === 'COURSE_UP') config.courseUpDeg = miBuque()?.headingDeg ?? 0;
      refrescarPanel();
    });
  }

  // Opciones de sí/no (RINGS, HEAD MARKER, NIGHT COLORS, ARPA, AUTO CLUTTER…)
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.rb-toggle')) {
    btn.addEventListener('click', () => {
      const op = btn.dataset.opcion as keyof PPIConfig;
      (config as unknown as Record<string, boolean>)[op] = !config[op];
      refrescarPanel();
    });
  }

  // EBL / VRM: el botón enciende/apaga; - / + ajustan el valor.
  for (const fila of document.querySelectorAll<HTMLElement>('.rp-marca')) {
    const marca: Marca = { tipo: fila.dataset.tipo as Marca['tipo'], i: Number(fila.dataset.i) as 0 | 1 };
    const obj = marca.tipo === 'ebl' ? config.ebl[marca.i] : config.vrm[marca.i];
    fila.querySelector<HTMLButtonElement>(':scope > .rb')!.addEventListener('click', () => {
      obj.activa = !obj.activa;
      marcaSeleccionada = obj.activa ? marca : null;
      refrescarPanel();
    });
    for (const b of fila.querySelectorAll<HTMLButtonElement>('[data-paso]')) {
      b.addEventListener('click', () => {
        const paso = Number(b.dataset.paso);
        marcaSeleccionada = marca;
        if (marca.tipo === 'ebl') {
          config.ebl[marca.i].bearingTrue = norm360(config.ebl[marca.i].bearingTrue + paso);
        } else {
          const delta = config.escalaNm / 60;
          config.vrm[marca.i].rangoNm = Math.max(0.01, Math.min(config.escalaNm, config.vrm[marca.i].rangoNm + paso * delta));
        }
        refrescarPanel();
      });
    }
  }

  // Pestañas
  for (const grupo of document.querySelectorAll<HTMLElement>('.rp-tabs')) {
    for (const tab of grupo.querySelectorAll<HTMLButtonElement>('.rp-tab')) {
      tab.addEventListener('click', () => {
        for (const t of grupo.querySelectorAll('.rp-tab')) t.setAttribute('aria-selected', String(t === tab));
        for (const p of grupo.querySelectorAll<HTMLElement>('.rp-tab-pagina')) p.hidden = p.dataset.tab !== tab.dataset.tab;
      });
    }
  }

  // ARPA
  el('btnAcquire').addEventListener('click', () => {
    modoClick = modoClick === 'adquirir' ? 'normal' : 'adquirir';
    refrescarPanel();
  });
  el('btnCease').addEventListener('click', () => {
    modoClick = modoClick === 'cesar' ? 'normal' : 'cesar';
    refrescarPanel();
  });
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.rb-vector')) {
    btn.addEventListener('click', () => {
      config.vector = btn.dataset.vector as PPIConfig['vector'];
      refrescarPanel();
    });
  }
  for (const caja of document.querySelectorAll<HTMLElement>('.rp-limite')) {
    const nombre = caja.dataset.limite as Limite;
    for (const b of caja.querySelectorAll<HTMLButtonElement>('[data-paso]')) {
      b.addEventListener('click', () => {
        const lim = LIMITES[nombre];
        const v = config[nombre] + Number(b.dataset.paso) * lim.paso;
        config[nombre] = Math.round(Math.max(lim.min, Math.min(lim.max, v)) * 10) / 10;
        refrescarPanel();
      });
    }
  }

  // Alarmas: click = reconocer.
  el('alarmaColision').addEventListener('click', () => { colisionReconocida = true; });
  el('alarmaNuevo').addEventListener('click', () => { nuevoBlancoHasta = 0; });
  el('alarmaPerdido').addEventListener('click', () => { blancoPerdido = false; });

  // Transmisor
  el('btnStandby').addEventListener('click', () => { config.transmitiendo = false; refrescarPanel(); });
  el('btnTransmit').addEventListener('click', () => { config.transmitiendo = true; refrescarPanel(); });
  el('btnInterf').addEventListener('click', (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });

  // Controles de señal
  const sliders: [string, string, 'ganancia' | 'sintonia' | 'mar' | null][] = [
    ['sliderGain', 'valGain', 'ganancia'],
    ['sliderTune', 'valTune', 'sintonia'],
    ['sliderSea', 'valSea', 'mar'],
    // No modelamos lluvia todavía: el control se ve pero no cambia la imagen.
    ['sliderRain', 'valRain', null],
  ];
  for (const [idSlider, idValor, campo] of sliders) {
    const s = el<HTMLInputElement>(idSlider);
    s.addEventListener('input', () => {
      el(idValor).textContent = s.value;
      if (campo) config[campo] = Number(s.value);
      publicarEstado();
    });
  }
}

// ----- Estado compartido con el profesor ("Show Radar") ------------------------
let ultimoEnvio = 0;
let envioPendiente: ReturnType<typeof setTimeout> | null = null;

function publicarEstado(): void {
  if (observando || !socket) return;
  // Como mucho 5 envíos por segundo mientras se arrastra una EBL/VRM.
  const espera = 200 - (Date.now() - ultimoEnvio);
  if (espera > 0) {
    envioPendiente ??= setTimeout(() => { envioPendiente = null; publicarEstado(); }, espera);
    return;
  }
  ultimoEnvio = Date.now();
  const estado: EstadoRadar = { config, arpa: arpa.todos().map((b) => b.ownshipIndex) };
  socket.emit('radar:estado', estado);
}

// El observador copia la configuración y los blancos ARPA del alumno.
function aplicarEstadoAlumno(estado: EstadoRadar): void {
  Object.assign(config, estado.config);
  const seguidos = new Set(estado.arpa);
  for (const b of arpa.todos()) if (!seguidos.has(b.ownshipIndex)) arpa.ceaseTrack(b.id);
  for (const os of seguidos) arpa.adquirirOwnship(os);
  for (const [idSlider, idValor, campo] of [
    ['sliderGain', 'valGain', 'ganancia'], ['sliderTune', 'valTune', 'sintonia'], ['sliderSea', 'valSea', 'mar'],
  ] as const) {
    el<HTMLInputElement>(idSlider).value = String(config[campo]);
    el(idValor).textContent = String(config[campo]);
  }
  refrescarPanel();
}

function cambiarEscala(sentido: number): void {
  const i = ESCALAS_NM.indexOf(config.escalaNm);
  const nuevo = ESCALAS_NM[Math.max(0, Math.min(ESCALAS_NM.length - 1, i + sentido))]!;
  config.escalaNm = nuevo;
  refrescarPanel();
}

// Pinta el estado de todos los botones y valores del panel según config.
function refrescarPanel(): void {
  el('rangeDisplay').textContent = formatEscala(config.escalaNm);
  el('hudRange').textContent = formatEscala(config.escalaNm);
  el('hudRings').textContent = formatEscala(ANILLOS_NM[config.escalaNm]);
  el('hudModo').textContent = { NORTH_UP: 'NORTH UP', HEAD_UP: 'HEAD UP', COURSE_UP: 'COURSE UP' }[config.mode];

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.rb-modo')) {
    presionado(btn, btn.dataset.modo === config.mode);
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.rb-toggle')) {
    presionado(btn, Boolean(config[btn.dataset.opcion as keyof PPIConfig]));
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.rb-vector')) {
    presionado(btn, btn.dataset.vector === config.vector);
  }
  for (const fila of document.querySelectorAll<HTMLElement>('.rp-marca')) {
    const i = Number(fila.dataset.i) as 0 | 1;
    const esEbl = fila.dataset.tipo === 'ebl';
    const activa = esEbl ? config.ebl[i].activa : config.vrm[i].activa;
    presionado(fila.querySelector<HTMLButtonElement>(':scope > .rb')!, activa);
    fila.querySelector<HTMLElement>('.rp-marca-valor')!.hidden = !activa;
    fila.classList.toggle('seleccionada',
      marcaSeleccionada?.tipo === fila.dataset.tipo && marcaSeleccionada?.i === i);
  }
  actualizarValoresMarcas();
  for (const caja of document.querySelectorAll<HTMLElement>('.rp-limite')) {
    const nombre = caja.dataset.limite as Limite;
    caja.querySelector('.rp-verde')!.textContent = config[nombre].toFixed(LIMITES[nombre].decimales);
  }
  presionado(el('btnAcquire'), modoClick === 'adquirir');
  presionado(el('btnCease'), modoClick === 'cesar');
  presionado(el('btnStandby'), !config.transmitiendo);
  presionado(el('btnTransmit'), config.transmitiendo);
  canvas.style.cursor = modoClick === 'normal' ? 'crosshair' : 'cell';
  publicarEstado();
}

function actualizarValoresMarcas(): void {
  const heading = miBuque()?.headingDeg ?? 0;
  for (const fila of document.querySelectorAll<HTMLElement>('.rp-marca')) {
    const i = Number(fila.dataset.i) as 0 | 1;
    const valor = fila.querySelector('.rp-verde')!;
    if (fila.dataset.tipo === 'ebl') {
      const t = config.ebl[i].bearingTrue;
      valor.textContent = `${fmt3(t)} / ${fmt3(norm360(t - heading))}`;
    } else {
      valor.textContent = config.vrm[i].rangoNm.toFixed(2);
    }
  }
}

function presionado(btn: HTMLElement, si: boolean): void {
  btn.setAttribute('aria-pressed', String(si));
}

// ----- Interacción con el PPI ------------------------------------------------
// Traduce una posición del mouse a marcación verdadera y distancia (millas).
function polarDesdeMouse(e: MouseEvent): { bearingTrue: number; distNm: number; distPx: number } | null {
  if (!ppi) return null;
  const rect = canvas.getBoundingClientRect();
  const { cx, cy, radio } = ppi.geometria();
  const dx = e.clientX - rect.left - cx;
  const dy = e.clientY - rect.top - cy;
  const distPx = Math.hypot(dx, dy);
  const pantalla = norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
  const bearingTrue = norm360(pantalla + PPI.rotacion(config, miBuque()));
  return { bearingTrue, distNm: (distPx / radio) * config.escalaNm, distPx };
}

function cablearPPI(): void {
  let arrastrando = false;

  const moverMarca = (e: MouseEvent) => {
    const p = polarDesdeMouse(e);
    if (!p || !marcaSeleccionada || p.distPx < 6) return;
    if (marcaSeleccionada.tipo === 'ebl') config.ebl[marcaSeleccionada.i].bearingTrue = p.bearingTrue;
    else config.vrm[marcaSeleccionada.i].rangoNm = Math.max(0.01, Math.min(config.escalaNm, p.distNm));
    actualizarValoresMarcas();
    publicarEstado();
  };

  canvas.addEventListener('mousedown', (e) => {
    const p = polarDesdeMouse(e);
    if (!p || observando) return;
    if (modoClick === 'adquirir') {
      const idx = buqueMasCercano(p.bearingTrue, p.distNm);
      if (idx !== null) {
        arpa.adquirirOwnship(idx);
        nuevoBlancoHasta = Date.now() + 5000;
      }
      publicarEstado();
      modoClick = 'normal';
      refrescarPanel();
      return;
    }
    if (modoClick === 'cesar') {
      const idx = buqueMasCercano(p.bearingTrue, p.distNm);
      if (idx !== null) arpa.ceaseTrack(`T-${idx}`);
      modoClick = 'normal';
      refrescarPanel();
      return;
    }
    const m = marcaSeleccionada;
    if (m && (m.tipo === 'ebl' ? config.ebl[m.i].activa : config.vrm[m.i].activa)) {
      arrastrando = true;
      moverMarca(e);
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (arrastrando) moverMarca(e);
  });
  window.addEventListener('mouseup', () => { arrastrando = false; });

  // MARKER INFO: distancia, marcación y posición del cursor.
  canvas.addEventListener('mousemove', (e) => {
    const p = polarDesdeMouse(e);
    const mio = miBuque();
    if (!p || !mio) return;
    el('hudMarkerRange').textContent = p.distNm.toFixed(2);
    el('hudMarkerBearing').textContent = p.bearingTrue.toFixed(1);
    const yN = Math.cos((p.bearingTrue * Math.PI) / 180) * p.distNm;
    const xE = Math.sin((p.bearingTrue * Math.PI) / 180) * p.distNm;
    const lat = mio.lat + yN / 60;
    const lon = mio.lon + xE / (60 * Math.cos((mio.lat * Math.PI) / 180));
    el('hudMarkerLat').textContent = formatDMS(lat, true);
    el('hudMarkerLon').textContent = formatDMS(lon, false);
  });
}

// Buque (ownshipIndex) más cercano a un punto del PPI, a menos de ~15 px.
function buqueMasCercano(bearingTrue: number, distNm: number): number | null {
  const mio = miBuque();
  if (!mio || !ppi) return null;
  const xE = Math.sin((bearingTrue * Math.PI) / 180) * distNm;
  const yN = Math.cos((bearingTrue * Math.PI) / 180) * distNm;
  const umbralNm = (15 / ppi.geometria().radio) * config.escalaNm;
  let mejor: { idx: number; d: number } | null = null;
  for (const b of otrosBuques()) {
    const rel = latLonAMillasRel(b.lat, b.lon, mio.lat, mio.lon);
    const d = Math.hypot(rel.xE - xE, rel.yN - yN);
    if (d < umbralNm && (!mejor || d < mejor.d)) mejor = { idx: b.ownshipIndex, d };
  }
  return mejor?.idx ?? null;
}

// ----- Datos en vivo ----------------------------------------------------------
function conectarSocket(): void {
  socket = io({ auth: { sesionId, vista: 'radar' }, withCredentials: true });
  socket.on('connect', () => {
    connBadge.textContent = 'conectado';
    connBadge.className = 'badge badge-abierta';
    publicarEstado();
  });
  socket.on('radar:estado', (m: { ownshipIndex: number; estado: EstadoRadar }) => {
    if (observando && m.ownshipIndex === miOwnshipIndex) aplicarEstadoAlumno(m.estado);
  });
  // Reenvío periódico: un profesor que abre "Show Radar" después ve el
  // estado actual sin esperar a que el alumno toque algo.
  if (!observando) setInterval(publicarEstado, 2000);
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
    // Blanco perdido: seguíamos un buque que ya no está en la sesión.
    const presentes = new Set(payload.buques.map((b) => b.ownshipIndex));
    for (const b of arpa.todos()) {
      if (!presentes.has(b.ownshipIndex)) {
        arpa.ceaseTrack(b.id);
        blancoPerdido = true;
      }
    }
    arpa.procesarTick(payload.t, payload.buques);
    const mio = miBuque();
    if (mio) arpaTargets = arpa.evaluar(mio, payload.buques).sort((a, b) => a.ownshipIndex - b.ownshipIndex);
    actualizarDatos();
  });
  socket.on('session:closed', () => {
    alert('El profesor cerró la sesión.');
    window.close();
  });
}

function actualizarDatos(): void {
  const mio = miBuque();
  if (!mio) return;
  el('hudHeading').textContent = mio.headingDeg.toFixed(1);
  el('hudSpeed').textContent = mio.velocidadKn.toFixed(1);
  el('hudCourse').textContent = mio.headingDeg.toFixed(1);
  el('hudOwnSpeed').textContent = mio.velocidadKn.toFixed(1);
  el('hudLat').textContent = formatDMS(mio.lat, true);
  el('hudLon').textContent = formatDMS(mio.lon, false);
  actualizarValoresMarcas();

  // Tabla de blancos: los dos primeros seguidos.
  for (const col of [0, 1] as const) {
    const t = arpaTargets[col];
    const b = t ? ultimoTick?.buques.find((x) => x.ownshipIndex === t.ownshipIndex) : undefined;
    const set = (id: string, v: string) => { el(`b${col}${id}`).textContent = v; };
    el(`blanco${col}Id`).textContent = t ? String(t.ownshipIndex) : '—';
    set('Lat', b ? formatDMS(b.lat, true) : '—');
    set('Lon', b ? formatDMS(b.lon, false) : '—');
    set('Brg', t ? `${t.bearingTrue.toFixed(1)}°` : '—');
    set('Rng', t ? `${t.rangeNm.toFixed(2)} nm` : '—');
    set('Crs', t && !Number.isNaN(t.courseDeg) ? `${t.courseDeg.toFixed(1)}°` : '—');
    set('Spd', t ? `${t.speedKn.toFixed(2)} kn` : '—');
    set('Cpa', t?.cpaNm != null ? `${t.cpaNm.toFixed(2)} nm` : '—');
    set('Tcpa', t?.tcpaMin != null ? `${t.tcpaMin.toFixed(1)} min` : '—');
    set('Aviso', t && esPeligroso(t, config) ? 'Collision Warning' : '');
  }

  // Alarmas
  const colision = config.arpaVisible && arpaTargets.some((t) => esPeligroso(t, config));
  if (!colision) colisionReconocida = false;
  const alarmaCol = el('alarmaColision');
  alarmaCol.classList.toggle('encendida', colision);
  alarmaCol.classList.toggle('titila', colision && !colisionReconocida);
  el('alarmaNuevo').classList.toggle('encendida', Date.now() < nuevoBlancoHasta);
  el('alarmaPerdido').classList.toggle('encendida', blancoPerdido);
}

function miBuque(): EstadoBuqueDTO | null {
  if (!ultimoTick) return null;
  return ultimoTick.buques.find((b) => b.ownshipIndex === miOwnshipIndex) ?? null;
}

function otrosBuques(): EstadoBuqueDTO[] {
  if (!ultimoTick) return [];
  return ultimoTick.buques.filter((b) => b.ownshipIndex !== miOwnshipIndex);
}

function loop(): void {
  ppi?.draw(miBuque(), otrosBuques(), cartaCache, config, arpaTargets);
  requestAnimationFrame(loop);
}

// ----- Helpers ----------------------------------------------------------------
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Falta #${id} en el HTML`);
  return e as T;
}

function showError(msg: string): void {
  loadingMsg.textContent = msg;
  loadingMsg.classList.remove('placeholder');
  loadingMsg.classList.add('auth-error');
}

function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

function fmt3(d: number): string {
  return d.toFixed(1).padStart(5, '0');
}

function formatEscala(nm: number): string {
  return nm < 1 ? String(nm) : nm.toFixed(0);
}

function formatDMS(coord: number, esLat: boolean): string {
  const abs = Math.abs(coord);
  const grados = Math.floor(abs);
  const minutos = ((abs - grados) * 60).toFixed(3);
  const sufijo = esLat ? (coord >= 0 ? 'N' : 'S') : coord >= 0 ? 'E' : 'W';
  return `${grados}°${minutos.padStart(6, '0')}'${sufijo}`;
}

window.addEventListener('resize', () => ppi?.resize());
el('logoutBtn').addEventListener('click', () => window.close());

void init();
