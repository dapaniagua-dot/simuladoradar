import { io, type Socket } from 'socket.io-client';
import { Reloj } from './aula/reloj.js';
import { Telegrafo } from './aula/telegrafo.js';
import { Navegador, type MarcaTraza, type ModoNavegador } from './aula/navegador.js';
import { CANALES_VHF, type CanalVHF } from '../shared/types.js';
import type {
  CartaParseada,
  EstadoBuqueDTO,
  LoginResponse,
  MensajeNavtex,
  MensajePrivado,
  MensajeVHF,
  PuntoTraza,
  ShipControlPayload,
  TickPayload,
  TrazaPuntoPayload,
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

// ----- DOM refs --------------------------------------------------------------
const userBadge = el<HTMLSpanElement>('userBadge');
const titulo = el<HTMLHeadingElement>('sesionTitulo');
const ownshipBadge = el<HTMLSpanElement>('ownshipBadge');
const connBadge = el<HTMLSpanElement>('connBadge');
const loadingMsg = el<HTMLDivElement>('loadingMsg');
const canvas = el<HTMLCanvasElement>('cartaCanvas');
const aulaMain = el<HTMLElement>('aulaMain');
const radarFrame = el<HTMLIFrameElement>('radarFrame');

// Consola (escenario escalable)
const consolaContenedor = el<HTMLDivElement>('consolaContenedor');
const consolaEscalador = el<HTMLDivElement>('consolaEscalador');
const consolaEscenario = el<HTMLDivElement>('consolaEscenario');

// Gobierno
const displayHeading = el<HTMLDivElement>('displayHeading');
const turnRateBabor = el<HTMLImageElement>('turnRateBabor');
const turnRateEstribor = el<HTMLImageElement>('turnRateEstribor');
const btnAuto = el<HTMLButtonElement>('btnAuto');
const inputSetCourse = el<HTMLInputElement>('inputSetCourse');
const btnEnter = el<HTMLButtonElement>('btnEnter');
const btnManual = el<HTMLButtonElement>('btnManual');
const displayRudder = el<HTMLDivElement>('displayRudder');
const joystick = el<HTMLDivElement>('joystick');
const joystickImg = el<HTMLImageElement>('joystickImg');

// Telégrafo
const telegrafoMount = el<HTMLDivElement>('telegrafoMount');

// LOG / DISTANCE / TIME
const btnLog1 = el<HTMLButtonElement>('btnLog1');
const btnLog2 = el<HTMLButtonElement>('btnLog2');
const displayLog = el<HTMLDivElement>('displayLog');
const btnDistReset = el<HTMLButtonElement>('btnDistReset');
const displayDistance = el<HTMLDivElement>('displayDistance');
const btnUtc = el<HTMLButtonElement>('btnUtc');
const btnLocal = el<HTMLButtonElement>('btnLocal');
const displayTime = el<HTMLDivElement>('displayTime');

// GPS
const displayLat = el<HTMLSpanElement>('displayLat');
const displayLon = el<HTMLSpanElement>('displayLon');
const displayGpsUtc = el<HTMLSpanElement>('displayGpsUtc');
const displayGpsSpeed = el<HTMLSpanElement>('displayGpsSpeed');
const displayGpsTrip = el<HTMLSpanElement>('displayGpsTrip');
const displayGpsCourse = el<HTMLSpanElement>('displayGpsCourse');
const lampAlarma = el<HTMLImageElement>('lampAlarma');
const lampLogFail = el<HTMLImageElement>('lampLogFail');

// VHF
const vhf = el<HTMLDivElement>('vhf');
const vhfLcd = el<HTMLDivElement>('vhfLcd');
const vhfCanalDisplay = el<HTMLSpanElement>('vhfCanalDisplay');
const vhfLcdInfo = el<HTMLDivElement>('vhfLcdInfo');

// ----- Estado --------------------------------------------------------------
let sesionId = 0;
let miOwnshipIndex = 0;
let navegador: Navegador | null = null;
// Modo observador: el profesor ve en vivo el aula de un alumno ("Show Console"),
// sin poder operar su buque.
let observando = false;
let ultimoTick: TickPayload | null = null;
let socket: Socket | null = null;
let telegrafo: Telegrafo | null = null;
let dialRudderCmd: Reloj | null = null;
let dialRudderAngle: Reloj | null = null;
let dialTurnRate: Reloj | null = null;
let dialWindSpeed: Reloj | null = null;
let dialWindDirection: Reloj | null = null;

// Estado local de la corredera (no afecta la simulación).
let logSeleccionado: 1 | 2 = 1;
let horaLocal = false;
let distanciaOffsetNm = 0;

// Estado de comunicaciones (MVP 6).
let canalActualVHF: CanalVHF = 16;
let vhfEncendido = true;
let vhfTecleo = '';
let userId = 0;
const mensajesVHFPorCanal = new Map<CanalVHF, MensajeVHF[]>();
const mensajesNavtex: MensajeNavtex[] = [];
const mensajesPrivados: MensajePrivado[] = [];
type TabComm = 'vhf' | 'navtex' | 'dm';
let tabActiva: TabComm = 'vhf';

// ----- Init ----------------------------------------------------------------
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
  userId = user.id;
  userBadge.textContent = `${user.nombre} (${user.role})`;

  sesionId = Number(params.get('sesion'));
  if (!Number.isFinite(sesionId) || sesionId <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  const consulta = observando ? `?observar=${Number(params.get('observar'))}` : '';
  const res = await fetch(`/api/aula/${sesionId}${consulta}`, { credentials: 'include' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    showError(err.error ?? 'No se pudo entrar a la sesión');
    return;
  }
  const { sesion, carta, observador } = (await res.json()) as AulaPayload;
  miOwnshipIndex = sesion.ownshipIndex;

  // El radar corre en su propia página (con su propio socket), embebida en
  // modo compacto. Solo la cargamos cuando sabemos que el alumno tiene acceso.
  radarFrame.src = `/radar.html?sesion=${sesionId}&embebido=1${consulta.replace('?', '&')}`;

  titulo.textContent = observador ? `${sesion.nombre} — ${observador.alumnoNombre} (solo lectura)` : sesion.nombre;
  if (observando) {
    document.body.classList.add('observando');
    document.title = `Aula OS-${sesion.ownshipIndex} — ${observador?.alumnoNombre ?? ''}`;
  }
  ownshipBadge.textContent = `OS-${sesion.ownshipIndex}`;
  ownshipBadge.classList.add('badge-abierta');

  const img = new Image();
  img.src = carta.rasterUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo cargar el PNG de la carta'));
  });
  loadingMsg.hidden = true;
  canvas.hidden = false;
  // Lo que el alumno configura en la carta (traza borrada, pausas, marcas)
  // se guarda por sesión y por alumno en este navegador.
  navegador = new Navegador(canvas, carta, img, `navegador-${sesionId}-${userId}`);

  inicializarWidgets();
  cablearControles();
  cablearComunicaciones();
  cablearNavegador();
  conectarSocket();
}

function inicializarWidgets(): void {
  telegrafo = new Telegrafo(telegrafoMount, (maquina, id) => {
    enviarComando(maquina === 'babor' ? { telegrafoBabor: id } : { telegrafoEstribor: id });
  });

  // Relojes con las esferas originales. Los ángulos se midieron sobre los
  // gráficos: el timón tiene el 0 abajo y ±40° a ~60° de las 12; el turn rate
  // y el viento barren ±135° desde arriba.
  const VENTANITA_ARRIBA = { x: 87, y: 55, w: 32, h: 16 };
  const VENTANITA_ABAJO = { x: 87, y: 130, w: 32, h: 16 };
  const timon = (v: number) => 180 - clamp(v, -40, 40) * 3;
  const magnitud = (v: number) => Math.abs(v).toFixed(0);
  dialRudderCmd = new Reloj(el('dialRudderCmd'), {
    imagen: '/img/consola/reloj-rudder-command.png',
    angulo: timon, texto: magnitud, ventanita: VENTANITA_ARRIBA,
  });
  dialRudderAngle = new Reloj(el('dialRudderAngle'), {
    imagen: '/img/consola/reloj-rudder-angle.png',
    angulo: timon, texto: magnitud, ventanita: VENTANITA_ARRIBA,
  });
  dialTurnRate = new Reloj(el('dialTurnRate'), {
    imagen: '/img/consola/reloj-turn-rate.png',
    angulo: (v) => (clamp(v, -300, 300) / 300) * 135, texto: magnitud, ventanita: VENTANITA_ABAJO,
  });
  dialWindSpeed = new Reloj(el('dialWindSpeed'), {
    imagen: '/img/consola/reloj-wind-speed.png',
    angulo: (v) => -135 + (clamp(v, 0, 150) / 150) * 270, texto: magnitud, ventanita: VENTANITA_ABAJO,
  });
  dialWindDirection = new Reloj(el('dialWindDirection'), {
    imagen: '/img/consola/reloj-wind-direction.png',
    angulo: (v) => v, marcadorEnAro: true,
  });

  // Precargar los estados "apretado" de los botones para que no parpadeen.
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.btn-img')) {
    new Image().src = `/img/consola/btn-${btn.dataset.img}-down.png`;
  }
  for (const pos of ['ll', 'l', 'c', 'r', 'rr']) new Image().src = `/img/consola/joystick-${pos}.png`;
}

function cablearControles(): void {
  // SET COURSE: se escribe en el display y se confirma con ENTER.
  botonMomentaneo(btnEnter, () => {
    const v = clampDeg(Number(inputSetCourse.value));
    inputSetCourse.value = formatRumbo(v);
    inputSetCourse.blur();
    enviarComando({ setCourseDeg: v });
  });
  inputSetCourse.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnEnter.click();
  });

  // AUTO / MANUAL: quedan "hundidos" según el modo que informa el server.
  btnAuto.addEventListener('click', () => enviarComando({ autopilotOn: true }));
  btnManual.addEventListener('click', () => enviarComando({ autopilotOn: false }));

  // Joystick: cada click en un costado mueve el timón 5°; el centro lo pone
  // a la vía.
  for (const zona of joystick.querySelectorAll<HTMLButtonElement>('.joystick-zona')) {
    zona.addEventListener('click', () => {
      const paso = Number(zona.dataset.paso);
      const actual = ultimoMioOnly()?.rudderCommandDeg ?? 0;
      aplicarRudder(paso === 0 ? 0 : actual + paso);
    });
  }
  // Atajo de teclado: flechas izquierda/derecha = 5° a babor/estribor, salvo
  // que el alumno esté escribiendo en un campo.
  window.addEventListener('keydown', (e) => {
    if (!puedeOperar()) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const actual = ultimoMioOnly()?.rudderCommandDeg ?? 0;
    aplicarRudder(actual + (e.key === 'ArrowLeft' ? -5 : 5));
    e.preventDefault();
  });

  // Corredera: LOG1/LOG2 y UTC/LOCAL son selectores excluyentes.
  btnLog1.addEventListener('click', () => { logSeleccionado = 1; pintarCorredera(); });
  btnLog2.addEventListener('click', () => { logSeleccionado = 2; pintarCorredera(); });
  btnUtc.addEventListener('click', () => { horaLocal = false; pintarCorredera(); });
  btnLocal.addEventListener('click', () => { horaLocal = true; pintarCorredera(); });
  botonMomentaneo(btnDistReset, () => {
    distanciaOffsetNm = ultimoMioOnly()?.distanceTotalNm ?? 0;
    actualizarWidgets();
  });
  pintarCorredera();

  // La consola mide 1025 px como la pantalla original; la escalamos para que
  // entre a lo ancho del panel en el que esté (principal o secundario).
  new ResizeObserver(escalarConsola).observe(consolaContenedor);
}

const ANCHO_CONSOLA = 1025;
const ALTO_CONSOLA = 785;

function escalarConsola(): void {
  const escala = Math.min(1.5, consolaContenedor.clientWidth / ANCHO_CONSOLA);
  consolaEscenario.style.transform = `scale(${escala})`;
  consolaEscalador.style.width = `${ANCHO_CONSOLA * escala}px`;
  consolaEscalador.style.height = `${ALTO_CONSOLA * escala}px`;
}

function pintarCorredera(): void {
  pintarBoton(btnLog1, logSeleccionado === 1);
  pintarBoton(btnLog2, logSeleccionado === 2);
  pintarBoton(btnUtc, !horaLocal);
  pintarBoton(btnLocal, horaLocal);
}

// Botón con gráfico original: muestra la imagen "down" o "up".
function pintarBoton(btn: HTMLButtonElement, apretado: boolean): void {
  const img = btn.querySelector('img')!;
  const src = `/img/consola/btn-${btn.dataset.img}-${apretado ? 'down' : 'up'}.png`;
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  btn.setAttribute('aria-pressed', String(apretado));
}

// Botón que se hunde solo mientras se lo aprieta (ENTER, DIST RESET).
function botonMomentaneo(btn: HTMLButtonElement, accion: () => void): void {
  btn.addEventListener('pointerdown', () => pintarBoton(btn, true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
    btn.addEventListener(ev, () => pintarBoton(btn, false));
  }
  btn.addEventListener('click', accion);
  btn.removeAttribute('aria-pressed');
}

function aplicarRudder(deg: number): void {
  const clamped = Math.max(-35, Math.min(35, Math.round(deg)));
  enviarComando({ rudderCommandDeg: clamped });
}

function clampDeg(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return ((Math.round(v) % 360) + 360) % 360;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function formatRumbo(deg: number): string {
  return Math.round(deg).toString().padStart(3, '0');
}

function conectarSocket(): void {
  socket = io({ auth: { sesionId, vista: 'aula' }, withCredentials: true });
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
  socket.on('chat:snapshot', (snap: { vhf: MensajeVHF[]; navtex: MensajeNavtex[]; privados: MensajePrivado[] }) => {
    mensajesVHFPorCanal.clear();
    for (const m of snap.vhf) {
      const list = mensajesVHFPorCanal.get(m.canal) ?? [];
      list.push(m);
      mensajesVHFPorCanal.set(m.canal, list);
    }
    mensajesNavtex.splice(0, mensajesNavtex.length, ...snap.navtex);
    mensajesPrivados.splice(0, mensajesPrivados.length, ...snap.privados);
    refrescarVHF();
    refrescarNavtex();
    refrescarDM();
  });
  socket.on('vhf:message', (m: MensajeVHF) => {
    const list = mensajesVHFPorCanal.get(m.canal) ?? [];
    list.push(m);
    mensajesVHFPorCanal.set(m.canal, list);
    if (m.canal === canalActualVHF && vhfEncendido) {
      refrescarVHF();
      marcarNuevo('vhf');
    }
  });
  socket.on('navtex:message', (m: MensajeNavtex) => {
    mensajesNavtex.push(m);
    refrescarNavtex();
    marcarNuevo('navtex');
  });
  socket.on('dm:message', (m: MensajePrivado) => {
    if (m.deUserId !== userId && m.paraUserId !== userId) return;
    mensajesPrivados.push(m);
    refrescarDM();
    if (m.deUserId !== userId) marcarNuevo('dm');
  });
  socket.on('world:tick', (payload: TickPayload) => {
    ultimoTick = payload;
    // Aislamos cualquier excepción del actualizado de widgets para que no
    // bloquee el resto del frame ni los siguientes ticks.
    try {
      actualizarWidgets();
    } catch (err) {
      console.error('actualizarWidgets falló:', err);
    }
    try {
      actualizarNavegador();
    } catch (err) {
      console.error('actualizarNavegador falló:', err);
    }
  });
  socket.on('traza:snapshot', (porBuque: Record<number, PuntoTraza[]>) => {
    navegador?.setTraza(porBuque[miOwnshipIndex] ?? []);
  });
  // Se cargó un ejercicio: los recorridos arrancan de cero.
  socket.on('traza:reinicio', () => navegador?.setTraza([]));
  socket.on('traza:punto', (p: TrazaPuntoPayload) => {
    if (p.ownshipIndex === miOwnshipIndex) navegador?.agregarPunto(p.punto);
  });
  socket.on('session:closed', () => {
    alert('El profesor cerró la sesión.');
    location.href = '/dashboard.html';
  });
}

function enviarComando(payload: ShipControlPayload): void {
  // El instructor con el control tomado manda los comandos a nombre del buque.
  socket?.emit('ship:control', observando ? { ...payload, ownshipIndex: miOwnshipIndex } : payload);
}

// ----- Comunicaciones -----
// Botonera del VHF 3001, en px del gráfico original (224x273). Cada tecla es
// un botón transparente encima del dibujo.
const TECLAS_VHF: { tecla: string; x: number; y: number; label: string }[] = [
  { tecla: 'lock', x: 139, y: 35, label: 'Lock' },
  { tecla: 'onoff', x: 176, y: 35, label: 'Encender / apagar' },
  { tecla: 'prog', x: 139, y: 71, label: 'Prog' },
  { tecla: 'config', x: 176, y: 71, label: 'Configuración' },
  { tecla: '1', x: 18, y: 116, label: '1' },
  { tecla: '2', x: 55, y: 116, label: '2' },
  { tecla: '3', x: 92, y: 116, label: '3' },
  { tecla: 'fp', x: 139, y: 116, label: 'F/P' },
  { tecla: 'potencia', x: 176, y: 116, label: 'Full/Low' },
  { tecla: '4', x: 18, y: 152, label: '4' },
  { tecla: '5', x: 55, y: 152, label: '5' },
  { tecla: '6', x: 92, y: 152, label: '6' },
  { tecla: 'sql', x: 139, y: 152, label: 'Squelch' },
  { tecla: 'parlante', x: 176, y: 152, label: 'Parlante' },
  { tecla: '7', x: 18, y: 188, label: '7' },
  { tecla: '8', x: 55, y: 188, label: '8' },
  { tecla: '9', x: 92, y: 188, label: '9' },
  { tecla: 'sqlmas', x: 139, y: 188, label: 'Squelch +' },
  { tecla: 'volmas', x: 176, y: 188, label: 'Volumen +' },
  { tecla: '0', x: 18, y: 224, label: '0' },
  { tecla: 'scan', x: 55, y: 224, label: 'Scan: siguiente canal' },
  { tecla: '16', x: 92, y: 224, label: 'Canal 16' },
  { tecla: 'sqlmenos', x: 139, y: 224, label: 'Squelch −' },
  { tecla: 'volmenos', x: 176, y: 224, label: 'Volumen −' },
];

function cablearComunicaciones(): void {
  for (const t of TECLAS_VHF) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vhf-tecla';
    b.style.left = `${t.x}px`;
    b.style.top = `${t.y}px`;
    b.title = t.label;
    b.setAttribute('aria-label', `VHF: ${t.label}`);
    b.addEventListener('click', () => teclaVHF(t.tecla));
    vhf.appendChild(b);
  }
  pintarVHF();

  const form = document.getElementById('vhfForm') as HTMLFormElement;
  const input = document.getElementById('vhfInput') as HTMLInputElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = input.value.trim();
    if (!texto || !vhfEncendido) return;
    socket?.emit('vhf:transmit', { canal: canalActualVHF, texto });
    input.value = '';
  });

  for (const tab of document.querySelectorAll<HTMLButtonElement>('.comm-tab')) {
    tab.addEventListener('click', () => seleccionarTab(tab.dataset.tab as TabComm));
  }
}

function teclaVHF(tecla: string): void {
  if (tecla === 'onoff') {
    vhfEncendido = !vhfEncendido;
    vhfTecleo = '';
  } else if (!vhfEncendido) {
    return;
  } else if (/^\d$/.test(tecla)) {
    // Canal de dos dígitos: el primero queda "tecleado" hasta el segundo.
    vhfTecleo += tecla;
    if (vhfTecleo.length === 2) {
      const canal = Number(vhfTecleo) as CanalVHF;
      vhfTecleo = '';
      if (CANALES_VHF.includes(canal)) cambiarCanal(canal);
      else vhfLcdInfo.textContent = 'CANAL NO VÁLIDO';
    }
  } else if (tecla === '16') {
    vhfTecleo = '';
    cambiarCanal(16);
  } else if (tecla === 'scan') {
    const i = CANALES_VHF.indexOf(canalActualVHF);
    cambiarCanal(CANALES_VHF[(i + 1) % CANALES_VHF.length]!);
  }
  pintarVHF();
}

function cambiarCanal(canal: CanalVHF): void {
  canalActualVHF = canal;
  vhfLcdInfo.textContent = '';
  refrescarVHF();
}

function pintarVHF(): void {
  vhfLcd.classList.toggle('apagado', !vhfEncendido);
  vhfCanalDisplay.textContent = vhfTecleo ? `${vhfTecleo}_` : String(canalActualVHF).padStart(2, '0');
  (document.getElementById('vhfInput') as HTMLInputElement).disabled = !vhfEncendido;
}

function seleccionarTab(tab: TabComm): void {
  tabActiva = tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.comm-tab')) {
    const activa = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(activa));
    if (activa) b.querySelector<HTMLElement>('.comm-nuevos')!.hidden = true;
  }
  for (const p of document.querySelectorAll<HTMLElement>('.comm-pagina')) {
    p.hidden = p.dataset.tab !== tab;
  }
}

// Punto de "mensaje nuevo" en la pestaña, si no es la que se está mirando.
function marcarNuevo(tab: TabComm): void {
  if (tab === tabActiva) return;
  const badge = document.querySelector<HTMLElement>(`.comm-tab[data-tab="${tab}"] .comm-nuevos`);
  if (badge) badge.hidden = false;
}

function refrescarVHF(): void {
  const list = document.getElementById('vhfMessages') as HTMLDivElement;
  const msgs = mensajesVHFPorCanal.get(canalActualVHF) ?? [];
  list.innerHTML = msgs
    .slice(-50)
    .map((m) => `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> <strong>${escape(m.remitenteNombre)}:</strong> ${escape(m.texto)}</div>`)
    .join('');
  list.scrollTop = list.scrollHeight;
  const ultimo = msgs[msgs.length - 1];
  if (ultimo && !vhfLcdInfo.textContent) vhfLcdInfo.textContent = `RX ${ultimo.remitenteNombre}`;
  pintarVHF();
}

function refrescarNavtex(): void {
  const list = document.getElementById('navtexMessages') as HTMLDivElement;
  list.innerHTML = mensajesNavtex
    .slice(-30)
    .map((m) => `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> ${escape(m.texto)}</div>`)
    .join('');
  list.scrollTop = list.scrollHeight;
}

function refrescarDM(): void {
  const list = document.getElementById('dmMessages') as HTMLDivElement;
  list.innerHTML = mensajesPrivados
    .slice(-30)
    .map((m) => {
      const direccion = m.deUserId === userId ? 'Yo →' : '← Instructor';
      return `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> <em>${direccion}</em> ${escape(m.texto)}</div>`;
    })
    .join('');
  list.scrollTop = list.scrollHeight;
}

function formatHora(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}

function ultimoMioOnly(): EstadoBuqueDTO | null {
  if (!ultimoTick) return null;
  return ultimoTick.buques.find((b) => b.ownshipIndex === miOwnshipIndex) ?? null;
}

function actualizarWidgets(): void {
  if (!ultimoTick) return;
  const mio = ultimoMioOnly();
  if (!mio) return;

  // Fallas inducidas por el instructor: los instrumentos afectados dejan de
  // dar datos (o quedan clavados) y se enciende la lámpara ALARM.
  const f = mio.fallas;
  const hayFalla = !!f && (f.gps || f.giro || f.log || f.autopiloto || f.maquina || f.radar
    || f.sectorCiegoDeg > 0 || f.ecoFalsoDeg !== null);
  pintarLampara(lampAlarma, 'alarm', hayFalla);
  pintarLampara(lampLogFail, 'logfail', !!f?.log);
  const rumboGiro = f?.giro ? mio.giroCongeladoDeg : mio.headingDeg;
  const rot = f?.giro ? 0 : mio.turnRateDegPerMin;

  // Control del buque: el alumno no opera mientras lo tiene el instructor; el
  // instructor observando sí puede, solo en ese caso.
  document.body.classList.toggle('bloqueado', !observando && mio.controlInstructor);
  document.body.classList.toggle('controlando', observando && mio.controlInstructor);
  el('avisoControl').hidden = !mio.controlInstructor;
  el('avisoControl').textContent = observando ? '⚠ Tenés el control de este buque' : '⚠ El instructor tomó el control de tu buque';

  // HEADING + barra de TURN RATE (±30°/min, como la escala impresa)
  displayHeading.textContent = rumboGiro.toFixed(1).padStart(5, '0');
  const fraccion = Math.min(1, Math.abs(rot) / 30);
  const oculto = `${((1 - fraccion) * 100).toFixed(1)}%`;
  // Rojo = cayendo a babor (se enciende del centro hacia la izquierda),
  // verde = a estribor (del centro hacia la derecha).
  turnRateBabor.style.clipPath = rot < 0 ? `inset(0 0 0 ${oculto})` : 'inset(0 0 0 100%)';
  turnRateEstribor.style.clipPath = rot > 0 ? `inset(0 ${oculto} 0 0)` : 'inset(0 100% 0 0)';

  // SET COURSE + AUTO/MANUAL
  pintarBoton(btnAuto, mio.autopilotOn);
  pintarBoton(btnManual, !mio.autopilotOn);
  if (document.activeElement !== inputSetCourse) {
    inputSetCourse.value = formatRumbo(mio.setCourseDeg);
  }

  // RUDDER COMMAND: magnitud + lado, y el joystick inclinado hacia ese lado.
  const rudder = Math.round(mio.rudderCommandDeg);
  displayRudder.textContent = rudder === 0 ? '0' : `${Math.abs(rudder)} ${rudder < 0 ? 'P' : 'S'}`;
  const posJoystick = rudder <= -20 ? 'll' : rudder < 0 ? 'l' : rudder >= 20 ? 'rr' : rudder > 0 ? 'r' : 'c';
  const srcJoystick = `/img/consola/joystick-${posJoystick}.png`;
  if (joystickImg.getAttribute('src') !== srcJoystick) joystickImg.setAttribute('src', srcJoystick);
  joystick.classList.toggle('deshabilitado', mio.autopilotOn);

  // Telégrafo: sincronizamos con el server (ej. el alumno tiene dos pestañas).
  telegrafo?.set('babor', mio.telegrafoBabor);
  telegrafo?.set('estribor', mio.telegrafoEstribor);

  // LOG (velocidad sobre el agua) / DISTANCE / TIME
  displayLog.textContent = f?.log ? '----' : mio.velocidadKn.toFixed(1);
  displayDistance.textContent = Math.max(0, (mio.distanceTotalNm ?? 0) - distanciaOffsetNm).toFixed(2);
  const utcTs = ultimoTick.ambiente?.utcTimestamp ?? Date.now();
  displayTime.textContent = horaLocal ? formatHora(utcTs) : formatUTC(utcTs);

  // GPS
  const gps = !f?.gps;
  displayLat.textContent = gps ? formatDMS(mio.lat, true) : 'NO FIX';
  displayLon.textContent = gps ? formatDMS(mio.lon, false) : '—';
  displayGpsUtc.textContent = formatUTC(utcTs);
  displayGpsSpeed.textContent = gps ? `${mio.velocidadKn.toFixed(1)} kt` : '— kt';
  displayGpsTrip.textContent = gps ? `${(mio.distanceTotalNm ?? 0).toFixed(2)} nm` : '— nm';
  displayGpsCourse.textContent = gps ? `${mio.headingDeg.toFixed(1)}°` : '—°';

  // Relojes
  dialRudderCmd?.setValue(mio.rudderCommandDeg ?? 0);
  dialRudderAngle?.setValue(mio.rudderAngleDeg ?? 0);
  dialTurnRate?.setValue(rot ?? 0);
  dialWindSpeed?.setValue(ultimoTick.ambiente?.windSpeedKn ?? 0);
  dialWindDirection?.setValue(ultimoTick.ambiente?.windDirectionDeg ?? 0);
}

// ----- Carta (Easy Navigator) ----------------------------------------------
const NOMBRES_MODO: Record<ModoNavegador, string> = {
  relative: 'Relative Motion', true: 'True Motion', chart: 'Chart Mode',
};

function cablearNavegador(): void {
  const nav = navegador!;
  // Íconos originales: activo / inactivo (deshabilitado) / marcado (elegido).
  const pintarBarra = () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-tb')) {
      const elegido = b.dataset.modo === nav.modo || b.dataset.herramienta === nav.herramienta
        || (b.dataset.accion === 'anillos' && nav.anillosNm !== null);
      const estado = b.disabled ? 'inactivo' : elegido ? 'marcado' : 'activo';
      b.style.backgroundImage = `url(/img/carta/tb-${b.dataset.icono}-${estado}.png)`;
      b.setAttribute('aria-pressed', String(elegido));
    }
    el('navEstadoModo').textContent = NOMBRES_MODO[nav.modo];
  };
  nav.onCambio = pintarBarra;

  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-tb')) {
    b.addEventListener('click', () => {
      if (b.dataset.modo) nav.setModo(b.dataset.modo as ModoNavegador);
      else if (b.dataset.herramienta) {
        nav.herramienta = b.dataset.herramienta as 'puntero' | 'medir';
        if (nav.herramienta === 'puntero') nav.limpiarMedicion();
      } else if (b.dataset.accion === 'zoom-mas') nav.zoom(1.5);
      else if (b.dataset.accion === 'zoom-menos') nav.zoom(1 / 1.5);
      else if (b.dataset.accion === 'anillos') {
        const sel = el<HTMLSelectElement>('navAnillos');
        sel.value = nav.anillosNm === null ? '1' : '';
        sel.dispatchEvent(new Event('change'));
      }
      pintarBarra();
    });
  }
  el<HTMLSelectElement>('navAnillos').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    nav.anillosNm = v ? Number(v) : null;
    nav.dibujar();
    pintarBarra();
  });
  pintarBarra();

  // Pestañas GPS / Trace
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.nav-tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.nav-tab')) t.setAttribute('aria-selected', String(t === tab));
      for (const p of document.querySelectorAll<HTMLElement>('.nav-pagina')) p.hidden = p.dataset.tab !== tab.dataset.tab;
    });
  }

  // GPS: largo del vector en minutos
  const vector = el<HTMLInputElement>('navVectorMin');
  vector.addEventListener('input', () => {
    const v = Number(vector.value);
    if (Number.isFinite(v) && v > 0) {
      nav.vectorMin = Math.min(60, v);
      nav.dibujar();
    }
  });

  // Trace
  const mostrar = el<HTMLInputElement>('navMostrarTraza');
  const muestrear = el<HTMLInputElement>('navMuestrear');
  muestrear.checked = nav.muestrear;
  mostrar.addEventListener('change', () => { nav.mostrarTraza = mostrar.checked; nav.dibujar(); });
  muestrear.addEventListener('change', () => nav.setMuestrear(muestrear.checked));
  el<HTMLSelectElement>('navIntervalo').addEventListener('change', (e) => {
    nav.intervaloSeg = Number((e.target as HTMLSelectElement).value);
    nav.dibujar();
  });
  el('navBorrarTraza').addEventListener('click', () => {
    if (confirm('¿Borrar el recorrido? No se puede deshacer.')) nav.borrarTraza();
  });

  // Marcas: el botón Mark abre el diálogo con la posición actual del buque.
  el('navMarcar').addEventListener('click', () => {
    const m = nav.nuevaMarca();
    if (m) abrirDialogoMarca(m, true);
  });
  nav.onAbrirMarca = (m) => abrirDialogoMarca(m, false);
  refrescarListaMarcas();

  // Barra de estado: distancia / marcación y posición del mouse.
  nav.onMouse = (info) => {
    if (!info) return;
    el('navEstadoMouse').textContent = info.rangoNm === null
      ? 'Range: — Bearing: —'
      : `Range: ${info.rangoNm.toFixed(3)}nm  Bearing: ${info.marcacion!.toFixed(2)}°`;
    el('navEstadoPos').textContent = `Lat:${formatDMS(info.lat, true)}  Long:${formatDMS(info.lon, false)}`;
  };
}

let marcaEnEdicion: { marca: MarcaTraza; nueva: boolean } | null = null;

function abrirDialogoMarca(m: MarcaTraza, nueva: boolean): void {
  marcaEnEdicion = { marca: m, nueva };
  el('navDlgLat').textContent = formatDMS(m.lat, true);
  el('navDlgLon').textContent = formatDMS(m.lon, false);
  el<HTMLInputElement>('navDlgNombre').value = m.nombre;
  el<HTMLTextAreaElement>('navDlgDesc').value = m.descripcion;
  el('navDlgBorrar').hidden = nueva;
  el<HTMLDialogElement>('navDialogo').showModal();
}

el<HTMLDialogElement>('navDialogo').addEventListener('close', () => {
  const dlg = el<HTMLDialogElement>('navDialogo');
  if (dlg.returnValue === 'aceptar' && marcaEnEdicion && navegador) {
    navegador.guardarMarca({
      ...marcaEnEdicion.marca,
      nombre: el<HTMLInputElement>('navDlgNombre').value.trim(),
      descripcion: el<HTMLTextAreaElement>('navDlgDesc').value.trim(),
    });
    refrescarListaMarcas();
  }
  marcaEnEdicion = null;
  dlg.returnValue = '';
});
el('navDlgBorrar').addEventListener('click', () => {
  if (marcaEnEdicion && navegador) {
    navegador.borrarMarca(marcaEnEdicion.marca.n);
    refrescarListaMarcas();
  }
  el<HTMLDialogElement>('navDialogo').close('cancelar');
});

function refrescarListaMarcas(): void {
  const lista = el<HTMLOListElement>('navMarcas');
  lista.innerHTML = '';
  for (const m of navegador?.listarMarcas() ?? []) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${m.n}${m.nombre ? ` · ${m.nombre}` : ''}`;
    b.addEventListener('click', () => abrirDialogoMarca(m, false));
    li.appendChild(b);
    lista.appendChild(li);
  }
}

function actualizarNavegador(): void {
  const mio = ultimoMioOnly();
  if (!mio || !navegador || !ultimoTick) return;
  // Sin GPS el plotter se queda con la última posición conocida (no se
  // actualiza el buque) y muestra "No Signal".
  const gps = !mio.fallas?.gps;
  if (gps) navegador.actualizarBuque(mio);
  el('navEstadoGps').textContent = gps ? 'Signal' : 'No Signal';
  el<HTMLImageElement>('navImgConectar').src = '/img/carta/conectar-inactivo.png';
  el<HTMLImageElement>('navImgDesconectar').src = '/img/carta/desconectar.png';
  el('navLat').textContent = gps ? formatDMS(mio.lat, true) : '—';
  el('navLon').textContent = gps ? formatDMS(mio.lon, false) : '—';
  el('navSog').textContent = gps ? Math.abs(mio.velocidadKn).toFixed(2) : '—';
  const rumboGiro = mio.fallas?.giro ? mio.giroCongeladoDeg : mio.headingDeg;
  el('navHeading').textContent = `${rumboGiro.toFixed(1).padStart(5, '0')}°`;
  el('navCourse').textContent = gps ? `${mio.headingDeg.toFixed(1).padStart(5, '0')}°` : '---.-°';
  el('navEstadoUtc').textContent = `UTC Time: ${formatUTC(ultimoTick.ambiente?.utcTimestamp ?? Date.now())}`;
}

// El alumno opera su buque salvo que el instructor tenga el control; el
// instructor observando solo opera si tomó el control.
function puedeOperar(): boolean {
  const mio = ultimoMioOnly();
  return observando ? !!mio?.controlInstructor : !mio?.controlInstructor;
}

// Lámparas del panel (ALARM, LOG FAIL): el gráfico "down" es el encendido.
function pintarLampara(img: HTMLImageElement, nombre: string, encendida: boolean): void {
  const src = `/img/consola/btn-${nombre}-${encendida ? 'down' : 'up'}.png`;
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  img.classList.toggle('titila', encendida);
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

function formatUTC(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// ----- Layout de una sola pantalla -------------------------------------------
// Una vista va en el lugar principal y las otras dos se apilan a la derecha,
// siempre en este orden relativo para que no "salten" al cambiar.
type Vista = 'radar' | 'consola' | 'carta';
const VISTAS: readonly Vista[] = ['radar', 'consola', 'carta'];

function seleccionarPrincipal(principal: Vista): void {
  aulaMain.dataset.principal = principal;
  const secundarias = VISTAS.filter((v) => v !== principal);
  for (const panel of aulaMain.querySelectorAll<HTMLElement>('.aula-panel')) {
    const vista = panel.dataset.vista as Vista;
    panel.style.gridArea = vista === principal ? 'principal' : `sec${secundarias.indexOf(vista) + 1}`;
    panel.classList.toggle('es-principal', vista === principal);
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.btn-vista')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.vista === principal));
  }
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('.btn-vista, .btn-agrandar')) {
  btn.addEventListener('click', () => seleccionarPrincipal(btn.dataset.vista as Vista));
}
// Por pedido de Diego, al entrar al aula el radar siempre arranca grande. El
// instructor puede pedir otra vista con ?principal= (su "Show Console").
const principalPedida = new URLSearchParams(location.search).get('principal') as Vista | null;
seleccionarPrincipal(principalPedida && VISTAS.includes(principalPedida) ? principalPedida : 'radar');

// Al cambiar de vista los paneles cambian de tamaño sin que cambie la ventana,
// por eso observamos los contenedores en vez de escuchar window.resize. El
// iframe del radar recibe su propio resize y se ajusta solo.

document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
