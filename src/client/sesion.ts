import { io, type Socket } from 'socket.io-client';
import { CartaInstructor } from './instructor/carta-instructor.js';
import type {
  ApiError,
  CartaParseada,
  EstadoBuqueDTO,
  LoginResponse,
  MensajeNavtex,
  MensajePrivado,
  MensajeVHF,
  Participacion,
  PublicUser,
  PresenciaEstado,
  PresenciaEvento,
  PuntoTraza,
  Sesion,
  TickPayload,
  TrazaPuntoPayload,
} from '../shared/types.js';

const titulo = el<HTMLElement>('sesionTitulo');
const loadingMsg = el<HTMLDivElement>('loadingMsg');
const canvas = el<HTMLCanvasElement>('cartaCanvas');
const alumnosLista = el<HTMLDivElement>('alumnosLista');
const addAlumnoForm = el<HTMLFormElement>('addAlumnoForm');
const addAlumnoSelect = addAlumnoForm.elements.namedItem('alumnoId') as HTMLSelectElement;
const addAlumnoError = el<HTMLParagraphElement>('addAlumnoError');
const modoBanner = el<HTMLDivElement>('modoUbicarBanner');
const modoTexto = el<HTMLSpanElement>('modoUbicarTexto');
const btnPlay = el<HTMLButtonElement>('btnPlay');
const btnPausa = el<HTMLButtonElement>('btnPausa');
const btnStop = el<HTMLButtonElement>('btnStop');

let sesionId = 0;
let sesion: Sesion | null = null;
let cartaVista: CartaInstructor | null = null;
let socket: Socket | null = null;
let ultimoTick: TickPayload | null = null;
let pausado = false;
let userId = 0;
const mensajesVHF: MensajeVHF[] = [];
const mensajesNavtex: MensajeNavtex[] = [];
const mensajesPrivados: MensajePrivado[] = [];
let participacionesActuales: Participacion[] = [];
let presencia: PresenciaEstado = {};
// Ventanas de "Show Radar" / "Show Console": una de cada una, se reutilizan al
// elegir otro alumno (como la PC de radar del instructor en el Melipal).
let ventanaRadar: Window | null = null;
let radarObservado: number | null = null;

async function init(): Promise<void> {
  const me = await fetch('/api/auth/me', { credentials: 'include' });
  if (!me.ok) {
    location.href = '/login.html';
    return;
  }
  const { user } = (await me.json()) as LoginResponse;
  if (user.role === 'alumno') {
    location.href = '/dashboard.html';
    return;
  }
  userId = user.id;
  el('userBadge').textContent = `${user.nombre} (${user.role})`;

  sesionId = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isFinite(sesionId) || sesionId <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  cablearInterfaz();
  await loadSesion();
  await loadCarta();
  await Promise.all([loadParticipaciones(), loadAlumnosDisponibles()]);
  setInterval(actualizarRelojes, 1000);
}

// ----- Sesión y estado de la simulación ------------------------------------------
async function loadSesion(): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}`, { credentials: 'include' });
  if (!res.ok) {
    showError('No se pudo cargar la sesión');
    return;
  }
  sesion = ((await res.json()) as { sesion: Sesion }).sesion;
  titulo.textContent = sesion.nombre;
  document.title = `${sesion.nombre} — Instructor`;
  el('exCarta').textContent = sesion.escenarioNombre;
  el('estadoBadge').textContent = sesion.estado.toUpperCase();
  el('descripcionEl').textContent = sesion.descripcion ?? '';
  refrescarEstado();
}

function refrescarEstado(): void {
  const estado = sesion?.estado ?? 'preparada';
  const abierta = estado === 'abierta';
  // Play abre la sesión (si está preparada) o la reanuda (si está en pausa).
  btnPlay.disabled = !(estado === 'preparada' || (abierta && pausado));
  btnPausa.disabled = !(abierta && !pausado);
  btnStop.disabled = !abierta;
  pintarBarra();

  const sim = el('simEstado');
  const [texto, clase] = estado === 'preparada' ? ['PREPARADA', 'preparada']
    : estado === 'finalizada' ? ['FINALIZADA', 'stop']
    : pausado ? ['PAUSE', 'pausa'] : ['RUN', 'run'];
  sim.textContent = texto;
  sim.dataset.estado = clase;

  if (abierta && !socket) conectarSocket();
  else if (!abierta && socket) {
    socket.disconnect();
    socket = null;
    ultimoTick = null;
    cartaVista?.setBuques([]);
    refrescarMatriz();
  }
  el('commAviso').hidden = abierta;
}

async function accionSesion(accion: 'abrir' | 'cerrar' | 'pausar' | 'reanudar', evento: string): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}/${accion}`, { method: 'POST', credentials: 'include' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    alert(err.error ?? `No se pudo ${accion}`);
    return;
  }
  registrarEvento(evento);
  if (accion === 'abrir' || accion === 'cerrar') {
    await loadSesion();
    await Promise.all([loadParticipaciones(), loadAlumnosDisponibles()]);
  }
}

btnPlay.addEventListener('click', async () => {
  if (sesion?.estado === 'preparada') {
    if (!confirm('¿Abrir la sesión? Los alumnos asignados van a poder entrar.')) return;
    await accionSesion('abrir', 'Sesión abierta');
  } else {
    await accionSesion('reanudar', 'Simulación reanudada');
  }
});
btnPausa.addEventListener('click', () => void accionSesion('pausar', 'Simulación en pausa'));
btnStop.addEventListener('click', async () => {
  if (!confirm('¿Terminar la sesión? Los alumnos van a perder el acceso.')) return;
  await accionSesion('cerrar', 'Sesión terminada');
});

// ----- Socket ----------------------------------------------------------------
function conectarSocket(): void {
  socket = io({ auth: { sesionId, vista: 'instructor' }, withCredentials: true });
  socket.on('world:tick', (payload: TickPayload) => {
    ultimoTick = payload;
    if (payload.pausado !== pausado) {
      pausado = payload.pausado;
      refrescarEstado();
    }
    cartaVista?.setBuques(payload.buques);
    refrescarMatriz();
    refrescarDatosOS();
  });
  socket.on('presencia:estado', (p: PresenciaEstado) => {
    presencia = p;
    refrescarPresencia();
  });
  socket.on('presencia:evento', (e: PresenciaEvento) => {
    const os = `OS-${String(e.ownshipIndex).padStart(2, '0')}`;
    registrarEvento(`${os} ${e.nombre}: ${e.vista === 'radar' ? 'radar' : 'aula'} ${e.conectado ? 'conectado' : 'desconectado'}`, e.ts);
  });
  socket.on('traza:snapshot', (porBuque: Record<number, PuntoTraza[]>) => cartaVista?.setTrazas(porBuque));
  socket.on('traza:punto', (p: TrazaPuntoPayload) => cartaVista?.agregarPunto(p.ownshipIndex, p.punto));
  socket.on('session:closed', () => {
    socket?.disconnect();
    socket = null;
    void loadSesion();
  });
  socket.on('chat:snapshot', (snap: { vhf: MensajeVHF[]; navtex: MensajeNavtex[]; privados: MensajePrivado[] }) => {
    mensajesVHF.splice(0, mensajesVHF.length, ...snap.vhf.filter((m) => m.canal === 16));
    mensajesNavtex.splice(0, mensajesNavtex.length, ...snap.navtex);
    mensajesPrivados.splice(0, mensajesPrivados.length, ...snap.privados);
    refrescarComms();
  });
  socket.on('vhf:message', (m: MensajeVHF) => {
    if (m.canal !== 16) return; // por ahora el profesor escucha solo canal 16
    mensajesVHF.push(m);
    refrescarComms();
    registrarEvento(`VHF ${m.remitenteNombre}`);
  });
  socket.on('navtex:message', (m: MensajeNavtex) => {
    mensajesNavtex.push(m);
    refrescarComms();
  });
  socket.on('dm:message', (m: MensajePrivado) => {
    if (m.deUserId !== userId && m.paraUserId !== userId) return;
    mensajesPrivados.push(m);
    refrescarComms();
    if (m.deUserId !== userId) registrarEvento('Mensaje de un alumno');
  });
}

// ----- Interfaz: barra, secciones, controles de la carta -------------------------
function cablearInterfaz(): void {
  // Secciones desplegables del panel izquierdo y la matriz.
  for (const cab of document.querySelectorAll<HTMLButtonElement>('.instr-seccion-cab')) {
    cab.addEventListener('click', () => {
      const s = cab.parentElement!;
      s.dataset.abierta = String(s.dataset.abierta !== 'true');
      if (s.classList.contains('instr-matriz')) cartaVista?.resize();
    });
  }
  el('btnSeccionOS').addEventListener('click', () => {
    const s = el('seccionOS');
    s.dataset.abierta = 'true';
    s.scrollIntoView({ behavior: 'smooth' });
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>('.instr-tb[data-herramienta]')) {
    b.addEventListener('click', () => {
      if (!cartaVista) return;
      cartaVista.herramienta = b.dataset.herramienta as 'puntero' | 'medir';
      if (cartaVista.herramienta === 'puntero') cartaVista.limpiarMedicion();
      pintarBarra();
    });
  }
  el('btnAjustar').addEventListener('click', () => cartaVista?.ajustarACarta());

  el<HTMLSelectElement>('selAnillos').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (cartaVista) { cartaVista.anillosNm = v ? Number(v) : null; cartaVista.dibujar(); }
  });
  el<HTMLSelectElement>('selVector').addEventListener('change', (e) => {
    if (cartaVista) { cartaVista.vectorMin = Number((e.target as HTMLSelectElement).value); cartaVista.dibujar(); }
  });
  el<HTMLInputElement>('chkTrazas').addEventListener('change', (e) => {
    if (cartaVista) { cartaVista.mostrarTrazas = (e.target as HTMLInputElement).checked; cartaVista.dibujar(); }
  });
  el<HTMLInputElement>('chkSegmentos').addEventListener('change', (e) => {
    if (cartaVista) { cartaVista.mostrarSegmentos = (e.target as HTMLInputElement).checked; cartaVista.dibujar(); }
  });
  el<HTMLInputElement>('chkBuques').addEventListener('change', (e) => {
    if (cartaVista) { cartaVista.mostrarBuques = (e.target as HTMLInputElement).checked; cartaVista.dibujar(); }
  });

  el('modoUbicarCancelar').addEventListener('click', cancelarUbicar);
  el('btnLimpiarEventos').addEventListener('click', () => { el('registroEventos').innerHTML = ''; });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cartaVista?.estaUbicando()) cancelarUbicar();
  });

  cablearComunicaciones();
  pintarBarra();
}

// Íconos originales; los deshabilitados en gris, la herramienta elegida hundida.
function pintarBarra(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.instr-tb')) {
    b.style.backgroundImage = `url(/img/instructor/${b.dataset.icono}.png)`;
    if (b.dataset.herramienta) {
      b.setAttribute('aria-pressed', String((cartaVista?.herramienta ?? 'puntero') === b.dataset.herramienta));
    }
  }
}

// ----- Carta -------------------------------------------------------------------
async function loadCarta(): Promise<void> {
  if (!sesion) return;
  const escRes = await fetch(`/api/escenarios/${sesion.escenarioId}`, { credentials: 'include' });
  if (!escRes.ok) {
    showError('No se pudo cargar la carta náutica');
    return;
  }
  const { carta } = (await escRes.json()) as { carta: CartaParseada };
  el('exAncho').textContent = `${carta.anchoMillas.toFixed(1)} nm`;
  el('exAlto').textContent = `${carta.altoMillas.toFixed(1)} nm`;

  const img = new Image();
  img.src = carta.rasterUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo cargar el PNG de la carta'));
  });
  loadingMsg.hidden = true;
  canvas.hidden = false;
  cartaVista = new CartaInstructor(canvas, carta, img);
  cartaVista.onMouse = (info) => {
    const set = (id: string, v: string) => { el(id).textContent = v; };
    if (!info) return;
    set('curLat', formatDMS(info.lat, true));
    set('curLon', formatDMS(info.lon, false));
    set('curBrg', info.marcacion === null ? '—' : `${info.marcacion.toFixed(1)}°`);
    set('curRng', info.rangoNm === null ? '—' : `${info.rangoNm.toFixed(2)} nm`);
    set('estLat', `Lat: ${formatDMS(info.lat, true)}`);
    set('estLon', `Long: ${formatDMS(info.lon, false)}`);
    set('estBrg', `Bearing: ${info.marcacion === null ? '—' : `${info.marcacion.toFixed(1)}°`}`);
    set('estRng', `Range: ${info.rangoNm === null ? '—' : `${info.rangoNm.toFixed(2)} nm`}`);
  };
  cartaVista.onSeleccion = (os) => {
    const ref = os === null ? 'FREE' : `OS-${String(os).padStart(2, '0')}`;
    el('curRef').textContent = ref;
    el('estRef').textContent = `Reference: ${ref}`;
    for (const row of alumnosLista.querySelectorAll<HTMLElement>('.instr-os')) {
      row.classList.toggle('seleccionado', Number(row.dataset.os) === os);
    }
  };
  cartaVista.onUbicado = (os, lat, lon, hdg) => {
    modoBanner.hidden = true;
    const p = participacionesActuales.find((x) => x.ownshipIndex === os);
    if (p) void guardarPosicion(p.id, lat, lon, hdg);
  };
  cartaVista.onCambio = pintarBarra;
  cartaVista.setIniciales(participacionesActuales);
}

// ----- Own Ships (alumnos) ---------------------------------------------------------
async function loadParticipaciones(): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}/participaciones`, { credentials: 'include' });
  if (!res.ok) {
    alumnosLista.innerHTML = `<p class="auth-error">Error cargando alumnos</p>`;
    return;
  }
  const { participaciones } = (await res.json()) as { participaciones: Participacion[] };
  participacionesActuales = participaciones;
  el('exCantOS').textContent = String(participaciones.length);
  cartaVista?.setIniciales(participaciones);
  refrescarDmDestinos();
  if (participaciones.length === 0) {
    alumnosLista.innerHTML = `<p class="instr-desc">Todavía no hay alumnos asignados a esta sesión.</p>`;
    return;
  }
  const editable = sesion?.estado === 'preparada';
  const puedeQuitar = sesion?.estado !== 'finalizada';
  alumnosLista.innerHTML = '';
  for (const p of participaciones) {
    const tienePos = p.latInicial !== null && p.lonInicial !== null;
    const row = document.createElement('div');
    row.className = 'instr-os';
    row.dataset.os = String(p.ownshipIndex);
    row.innerHTML = `
      <div class="instr-os-cab">
        <button type="button" class="instr-os-tag" data-centrar title="Centrar en la carta y tomar de referencia">OS-${String(p.ownshipIndex).padStart(2, '0')}</button>
        <span class="instr-os-nombre" title="${escape(p.alumnoEmail)}">${escape(p.alumnoNombre)}</span>
        ${puedeQuitar ? `<button type="button" class="instr-btn-chico" data-quitar title="Quitar de la sesión">✕</button>` : ''}
      </div>
      <div class="instr-os-datos" data-vivo>${editable ? (tienePos ? 'Posición inicial fijada' : 'Posición automática') : '—'}</div>
      ${sesion?.estado === 'abierta' ? `
      <div class="instr-os-vivo">
        <span class="instr-conexion" data-conexion>Aula <b data-aula>NO</b> · Radar <b data-radar>NO</b></span>
        <button type="button" data-ver-radar title="Ver en vivo el radar de este alumno">Show Radar</button>
        <button type="button" data-ver-consola title="Ver en vivo el aula (consola, radar y carta) de este alumno">Show Console</button>
      </div>` : ''}
      ${editable ? `
      <div class="instr-os-pos">
        <label>LAT <input type="number" step="0.0001" data-lat value="${p.latInicial ?? ''}" /></label>
        <label>LON <input type="number" step="0.0001" data-lon value="${p.lonInicial ?? ''}" /></label>
        <label>HDG <input type="number" min="0" max="359" step="1" data-hdg value="${p.headingInicial ?? 0}" /></label>
      </div>
      <div class="instr-os-acciones">
        <button type="button" data-ubicar>Ubicar en carta</button>
        <button type="button" data-guardar>Guardar</button>
        ${tienePos ? '<button type="button" data-limpiar>Automática</button>' : ''}
      </div>` : ''}
    `;
    row.querySelector('[data-centrar]')!.addEventListener('click', () => {
      cartaVista?.seleccionar(p.ownshipIndex);
      cartaVista?.centrarBuque(p.ownshipIndex);
    });
    row.querySelector('[data-quitar]')?.addEventListener('click', async () => {
      if (!confirm(`¿Quitar a ${p.alumnoNombre} de la sesión?`)) return;
      await fetch(`/api/sesiones/${sesionId}/participaciones/${p.id}`, { method: 'DELETE', credentials: 'include' });
      await Promise.all([loadParticipaciones(), loadAlumnosDisponibles()]);
    });
    row.querySelector('[data-ubicar]')?.addEventListener('click', () => iniciarUbicar(p));
    row.querySelector('[data-ver-radar]')?.addEventListener('click', () => verRadar(p));
    row.querySelector('[data-ver-consola]')?.addEventListener('click', () => verConsola(p));
    row.querySelector('[data-guardar]')?.addEventListener('click', async () => {
      const num = (sel: string) => Number(row.querySelector<HTMLInputElement>(sel)!.value);
      const [lat, lon, hdg] = [num('[data-lat]'), num('[data-lon]'), num('[data-hdg]')];
      if (![lat, lon, hdg].every(Number.isFinite)) {
        alert('Lat / Lon / Heading inválidos');
        return;
      }
      await guardarPosicion(p.id, lat, lon, hdg);
    });
    row.querySelector('[data-limpiar]')?.addEventListener('click', async () => {
      if (!confirm('¿Volver al reparto automático para este buque?')) return;
      await fetch(`/api/sesiones/${sesionId}/participaciones/${p.id}/posicion`, { method: 'DELETE', credentials: 'include' });
      await loadParticipaciones();
    });
    alumnosLista.appendChild(row);
  }
  cartaVista?.onSeleccion(cartaVista.seleccionado);
  refrescarPresencia();
}

// ----- Show Radar / Show Console --------------------------------------------------
function verRadar(p: Participacion): void {
  const url = `/radar.html?sesion=${sesionId}&observar=${p.ownshipIndex}`;
  ventanaRadar = window.open(url, 'melipal-radar-instructor', 'width=1280,height=900');
  radarObservado = p.ownshipIndex;
  el('radarObservado').textContent = `OS-${String(p.ownshipIndex).padStart(2, '0')} · ${p.alumnoNombre}`;
  registrarEvento(`Show Radar OS-${String(p.ownshipIndex).padStart(2, '0')}`);
}

function verConsola(p: Participacion): void {
  const url = `/aula.html?sesion=${sesionId}&observar=${p.ownshipIndex}&principal=consola`;
  window.open(url, 'melipal-aula-instructor', 'width=1500,height=950');
  registrarEvento(`Show Console OS-${String(p.ownshipIndex).padStart(2, '0')}`);
}

// Si el profesor cierra la ventana del radar, "Seeing Radar from Post" vuelve a NONE.
setInterval(() => {
  if (radarObservado !== null && ventanaRadar?.closed) {
    radarObservado = null;
    el('radarObservado').textContent = 'NONE';
  }
}, 1000);

function refrescarPresencia(): void {
  for (const row of alumnosLista.querySelectorAll<HTMLElement>('.instr-os')) {
    const p = presencia[Number(row.dataset.os)];
    const pintar = (sel: string, n: number) => {
      const b = row.querySelector<HTMLElement>(sel);
      if (!b) return;
      b.textContent = n > 0 ? 'SÍ' : 'NO';
      b.dataset.conectado = String(n > 0);
    };
    pintar('[data-aula]', p?.aula ?? 0);
    pintar('[data-radar]', p?.radar ?? 0);
  }
}

// Datos en vivo de cada buque en su fila (rumbo, velocidad, máquinas, timón).
function refrescarDatosOS(): void {
  if (!ultimoTick) return;
  for (const row of alumnosLista.querySelectorAll<HTMLElement>('.instr-os')) {
    const b = ultimoTick.buques.find((x) => x.ownshipIndex === Number(row.dataset.os));
    const datos = row.querySelector<HTMLElement>('[data-vivo]');
    if (!datos || !b) continue;
    const timon = Math.round(b.rudderCommandDeg);
    datos.textContent = `HDG ${b.headingDeg.toFixed(1)}° · ${b.velocidadKn.toFixed(1)} kn · `
      + `Tel ${b.telegrafoBabor}/${b.telegrafoEstribor} · Timón ${timon === 0 ? '0' : `${Math.abs(timon)}${timon < 0 ? 'P' : 'S'}`}`
      + (b.autopilotOn ? ` · AUTO ${Math.round(b.setCourseDeg)}°` : '');
  }
}

function iniciarUbicar(p: Participacion): void {
  if (!cartaVista || sesion?.estado !== 'preparada') return;
  cartaVista.iniciarUbicar(p.ownshipIndex);
  modoBanner.hidden = false;
  modoTexto.textContent = `Ubicar OS-${String(p.ownshipIndex).padStart(2, '0')} (${p.alumnoNombre}): hacé click en la carta y arrastrá para fijar el rumbo.`;
}

function cancelarUbicar(): void {
  cartaVista?.cancelarUbicar();
  modoBanner.hidden = true;
}

async function guardarPosicion(partId: number, lat: number, lon: number, hdg: number): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}/participaciones/${partId}/posicion`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ lat, lon, headingDeg: hdg }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    alert(err.error ?? 'No se pudo guardar la posición');
    return;
  }
  await loadParticipaciones();
}

async function loadAlumnosDisponibles(): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}/alumnos-disponibles`, { credentials: 'include' });
  if (!res.ok) return;
  const { alumnos } = (await res.json()) as { alumnos: Pick<PublicUser, 'id' | 'email' | 'nombre'>[] };
  while (addAlumnoSelect.options.length > 1) addAlumnoSelect.remove(1);
  for (const a of alumnos) {
    const opt = document.createElement('option');
    opt.value = String(a.id);
    opt.textContent = `${a.nombre} (${a.email})`;
    addAlumnoSelect.appendChild(opt);
  }
  const finalizada = sesion?.estado === 'finalizada';
  addAlumnoSelect.disabled = finalizada;
  (addAlumnoForm.querySelector('button[type="submit"]') as HTMLButtonElement).disabled = finalizada;
}

addAlumnoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addAlumnoError.hidden = true;
  const alumnoId = Number(addAlumnoSelect.value);
  if (!alumnoId) return;
  const res = await fetch(`/api/sesiones/${sesionId}/participaciones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ alumnoId }),
  });
  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    addAlumnoError.textContent = err.error ?? 'No se pudo agregar el alumno';
    addAlumnoError.hidden = false;
    return;
  }
  addAlumnoSelect.value = '';
  await Promise.all([loadParticipaciones(), loadAlumnosDisponibles()]);
});

// ----- Matriz CPA - TCPA -----------------------------------------------------------
// Para cada par de buques: marcación y distancia actuales, y punto de máximo
// acercamiento suponiendo que ambos mantienen rumbo y velocidad.
function cpaEntre(a: EstadoBuqueDTO, b: EstadoBuqueDTO): { brg: number; rng: number; cpa: number; tcpaMin: number | null } {
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const xE = (b.lon - a.lon) * 60 * cosLat;
  const yN = (b.lat - a.lat) * 60;
  const vel = (x: EstadoBuqueDTO) => {
    const r = (x.headingDeg * Math.PI) / 180;
    return [Math.sin(r) * x.velocidadKn, Math.cos(r) * x.velocidadKn];
  };
  const [aE, aN] = vel(a);
  const [bE, bN] = vel(b);
  const vE = bE - aE;
  const vN = bN - aN;
  const v2 = vE * vE + vN * vN;
  const rng = Math.hypot(xE, yN);
  const brg = ((Math.atan2(xE, yN) * 180) / Math.PI + 360) % 360;
  if (v2 < 1e-9) return { brg, rng, cpa: rng, tcpaMin: null };
  const tHoras = -(xE * vE + yN * vN) / v2;
  return { brg, rng, cpa: Math.hypot(xE + vE * tHoras, yN + vN * tHoras), tcpaMin: tHoras * 60 };
}

function refrescarMatriz(): void {
  const tabla = el<HTMLTableElement>('matrizCpa');
  const buques = ultimoTick?.buques ?? [];
  if (buques.length === 0) {
    tabla.innerHTML = '<tbody><tr><td class="instr-desc">Sin buques en simulación.</td></tr></tbody>';
    return;
  }
  const os = (b: EstadoBuqueDTO) => `OS-${String(b.ownshipIndex).padStart(2, '0')}`;
  let html = '<thead><tr><th rowspan="2"></th><th rowspan="2">Course</th><th rowspan="2">Speed</th>';
  html += buques.map((b) => `<th colspan="4">${os(b)}</th>`).join('') + '</tr><tr>';
  html += buques.map(() => '<th>Bearing</th><th>Range</th><th>CPA</th><th>TCPA</th>').join('') + '</tr></thead><tbody>';
  for (const a of buques) {
    html += `<tr><th>${os(a)}</th><td>${a.headingDeg.toFixed(1)}</td><td>${a.velocidadKn.toFixed(1)}</td>`;
    for (const b of buques) {
      if (a === b) {
        html += '<td colspan="4" class="instr-matriz-diag">--------</td>';
        continue;
      }
      const c = cpaEntre(a, b);
      html += `<td>${c.brg.toFixed(1)}</td><td>${c.rng.toFixed(2)}</td><td>${c.cpa.toFixed(2)}</td>`
        + `<td>${c.tcpaMin === null ? '—' : Math.round(c.tcpaMin)}</td>`;
    }
    html += '</tr>';
  }
  tabla.innerHTML = html + '</tbody>';
}

// ----- Relojes y eventos ------------------------------------------------------------
function actualizarRelojes(): void {
  const local = formatHora(Date.now());
  el('simLocal').textContent = local;
  el('estLocal').textContent = `Local Time: ${local}`;
  const abierta = sesion?.estado === 'abierta' && sesion.openedAt;
  const seg = abierta ? Math.max(0, Math.floor((Date.now() - new Date(sesion!.openedAt!).getTime()) / 1000)) : 0;
  const elapsed = `${pad(Math.floor(seg / 3600))}:${pad(Math.floor((seg % 3600) / 60))}:${pad(seg % 60)}`;
  el('simElapsed').textContent = elapsed;
  el('estElapsed').textContent = `Elapsed Time: ${elapsed}`;
}

function registrarEvento(texto: string, ts = Date.now()): void {
  el('estEvento').textContent = `Last Event: ${formatHora(ts)} ${texto}`;
  const lista = el<HTMLOListElement>('registroEventos');
  const li = document.createElement('li');
  li.textContent = `${formatHora(ts)} ${texto}`;
  lista.appendChild(li);
  while (lista.children.length > 200) lista.firstElementChild!.remove();
  lista.scrollTop = lista.scrollHeight;
}

// ----- Comunicaciones -----------------------------------------------------------
function cablearComunicaciones(): void {
  const enviar = (formId: string, inputId: string, fn: (texto: string) => void) => {
    const form = el<HTMLFormElement>(formId);
    const input = el<HTMLInputElement>(inputId);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const texto = input.value.trim();
      if (!texto || !socket) return;
      fn(texto);
      input.value = '';
    });
  };
  enviar('vhfForm', 'vhfInput', (texto) => socket?.emit('vhf:transmit', { canal: 16, texto }));
  enviar('navtexForm', 'navtexInput', (texto) => socket?.emit('navtex:send', { texto }));
  enviar('dmForm', 'dmInput', (texto) => {
    const para = Number(el<HTMLSelectElement>('dmDestino').value);
    if (Number.isFinite(para) && para > 0) socket?.emit('dm:send', { paraUserId: para, texto });
  });
}

function refrescarDmDestinos(): void {
  const select = el<HTMLSelectElement>('dmDestino');
  const valorPrev = select.value;
  select.innerHTML = '';
  if (participacionesActuales.length === 0) {
    select.innerHTML = '<option value="" disabled>Sin alumnos asignados</option>';
    return;
  }
  for (const p of participacionesActuales) {
    const opt = document.createElement('option');
    opt.value = String(p.alumnoId);
    opt.textContent = `OS-${p.ownshipIndex} · ${p.alumnoNombre}`;
    select.appendChild(opt);
  }
  if (valorPrev && participacionesActuales.some((p) => String(p.alumnoId) === valorPrev)) select.value = valorPrev;
}

function refrescarComms(): void {
  const pintar = (id: string, items: string[]) => {
    const lista = el<HTMLDivElement>(id);
    lista.innerHTML = items.join('');
    lista.scrollTop = lista.scrollHeight;
  };
  pintar('vhfMessages', mensajesVHF.slice(-50).map((m) =>
    `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> <strong>${escape(m.remitenteNombre)}:</strong> ${escape(m.texto)}</div>`));
  pintar('navtexMessages', mensajesNavtex.slice(-30).map((m) =>
    `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> ${escape(m.texto)}</div>`));
  pintar('dmMessages', mensajesPrivados.slice(-30).map((m) =>
    `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> <em>${m.deUserId === userId ? 'Yo →' : '← Alumno'}</em> ${escape(m.texto)}</div>`));
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

function formatHora(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatDMS(coord: number, esLat: boolean): string {
  const abs = Math.abs(coord);
  const grados = Math.floor(abs);
  const minutos = ((abs - grados) * 60).toFixed(3);
  const sufijo = esLat ? (coord >= 0 ? 'N' : 'S') : coord >= 0 ? 'E' : 'W';
  return `${grados}°${minutos.padStart(6, '0')}'${sufijo}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}

el('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
