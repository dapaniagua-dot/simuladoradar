import { io, type Socket } from 'socket.io-client';
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
  Sesion,
  TickPayload,
} from '../shared/types.js';

const userBadge = document.getElementById('userBadge') as HTMLSpanElement;
const titulo = document.getElementById('sesionTitulo') as HTMLHeadingElement;
const cartaNombre = document.getElementById('cartaNombre') as HTMLSpanElement;
const estadoBadge = document.getElementById('estadoBadge') as HTMLSpanElement;
const descripcionEl = document.getElementById('descripcionEl') as HTMLParagraphElement;
const cartaInfo = document.getElementById('cartaInfo') as HTMLSpanElement;
const loadingMsg = document.getElementById('loadingMsg') as HTMLDivElement;
const canvas = document.getElementById('cartaCanvas') as HTMLCanvasElement;
const toggleSegmentos = document.getElementById('toggleSegmentos') as HTMLInputElement;
const btnAbrir = document.getElementById('btnAbrir') as HTMLButtonElement;
const btnPausar = document.getElementById('btnPausar') as HTMLButtonElement;
const btnReanudar = document.getElementById('btnReanudar') as HTMLButtonElement;
const btnCerrar = document.getElementById('btnCerrar') as HTMLButtonElement;
const liveBadge = document.getElementById('liveBadge') as HTMLSpanElement;
const alumnosLista = document.getElementById('alumnosLista') as HTMLDivElement;
const addAlumnoForm = document.getElementById('addAlumnoForm') as HTMLFormElement;
const addAlumnoSelect = addAlumnoForm.elements.namedItem('alumnoId') as HTMLSelectElement;
const addAlumnoError = document.getElementById('addAlumnoError') as HTMLParagraphElement;

let sesionId = 0;
let sesionEstado: Sesion['estado'] = 'preparada';
let cartaCache: CartaParseada | null = null;
let imagenCache: HTMLImageElement | null = null;
let socket: Socket | null = null;
let ultimoTick: TickPayload | null = null;
let pausado = false;
let userId = 0;
const mensajesVHF: MensajeVHF[] = [];
const mensajesNavtex: MensajeNavtex[] = [];
const mensajesPrivados: MensajePrivado[] = [];
let participacionesActuales: Participacion[] = [];

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
  userBadge.textContent = `${user.nombre} (${user.role})`;

  const params = new URLSearchParams(location.search);
  sesionId = Number(params.get('id'));
  if (!Number.isFinite(sesionId) || sesionId <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  await loadSesion();
  await Promise.all([loadParticipaciones(), loadAlumnosDisponibles(), loadCarta()]);
}

async function loadSesion(): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}`, { credentials: 'include' });
  if (!res.ok) {
    showError('No se pudo cargar la sesión');
    return;
  }
  const { sesion } = (await res.json()) as { sesion: Sesion };
  titulo.textContent = sesion.nombre;
  cartaNombre.textContent = sesion.escenarioNombre;
  estadoBadge.textContent = sesion.estado.toUpperCase();
  estadoBadge.className = `badge badge-${sesion.estado}`;
  if (sesion.descripcion) {
    descripcionEl.textContent = sesion.descripcion;
  }
  sesionEstado = sesion.estado;
  refrescarBotonesEstado();
}

function refrescarBotonesEstado(): void {
  btnAbrir.hidden = sesionEstado !== 'preparada';
  btnCerrar.hidden = sesionEstado !== 'abierta';
  btnPausar.hidden = sesionEstado !== 'abierta' || pausado;
  btnReanudar.hidden = sesionEstado !== 'abierta' || !pausado;
  liveBadge.hidden = sesionEstado !== 'abierta';
  liveBadge.textContent = pausado ? 'PAUSADO' : 'EN VIVO';
  liveBadge.className = `badge ${pausado ? 'badge-finalizada' : 'badge-abierta'}`;

  // Conectar/desconectar socket según el estado
  if (sesionEstado === 'abierta' && !socket) {
    conectarSocket();
  } else if (sesionEstado !== 'abierta' && socket) {
    socket.disconnect();
    socket = null;
    ultimoTick = null;
    redraw();
  }
}

function conectarSocket(): void {
  socket = io({ auth: { sesionId }, withCredentials: true });
  socket.on('world:tick', (payload: TickPayload) => {
    ultimoTick = payload;
    if (payload.pausado !== pausado) {
      pausado = payload.pausado;
      refrescarBotonesEstado();
    }
    redraw();
  });
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
  });
  socket.on('navtex:message', (m: MensajeNavtex) => {
    mensajesNavtex.push(m);
    refrescarComms();
  });
  socket.on('dm:message', (m: MensajePrivado) => {
    if (m.deUserId !== userId && m.paraUserId !== userId) return;
    mensajesPrivados.push(m);
    refrescarComms();
  });

  cablearComunicaciones();
  document.getElementById('commPanel')!.hidden = false;
}

function cablearComunicaciones(): void {
  const vhfForm = document.getElementById('vhfForm') as HTMLFormElement | null;
  const vhfInput = document.getElementById('vhfInput') as HTMLInputElement | null;
  const navtexForm = document.getElementById('navtexForm') as HTMLFormElement | null;
  const navtexInput = document.getElementById('navtexInput') as HTMLInputElement | null;
  const dmForm = document.getElementById('dmForm') as HTMLFormElement | null;
  const dmInput = document.getElementById('dmInput') as HTMLInputElement | null;

  if (vhfForm && vhfInput && !vhfForm.dataset.wired) {
    vhfForm.dataset.wired = '1';
    vhfForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const texto = vhfInput.value.trim();
      if (!texto) return;
      socket?.emit('vhf:transmit', { canal: 16, texto });
      vhfInput.value = '';
    });
  }
  if (navtexForm && navtexInput && !navtexForm.dataset.wired) {
    navtexForm.dataset.wired = '1';
    navtexForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const texto = navtexInput.value.trim();
      if (!texto) return;
      socket?.emit('navtex:send', { texto });
      navtexInput.value = '';
    });
  }
  if (dmForm && dmInput && !dmForm.dataset.wired) {
    dmForm.dataset.wired = '1';
    dmForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const select = document.getElementById('dmDestino') as HTMLSelectElement;
      const para = Number(select.value);
      const texto = dmInput.value.trim();
      if (!texto || !Number.isFinite(para) || para <= 0) return;
      socket?.emit('dm:send', { paraUserId: para, texto });
      dmInput.value = '';
    });
  }
  refrescarDmDestinos();
}

function refrescarDmDestinos(): void {
  const select = document.getElementById('dmDestino') as HTMLSelectElement | null;
  if (!select) return;
  const valorPrev = select.value;
  select.innerHTML = '';
  if (participacionesActuales.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Sin alumnos asignados';
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }
  for (const p of participacionesActuales) {
    const opt = document.createElement('option');
    opt.value = String(p.alumnoId);
    opt.textContent = `OS-${p.ownshipIndex} · ${p.alumnoNombre}`;
    select.appendChild(opt);
  }
  if (valorPrev && participacionesActuales.some((p) => String(p.alumnoId) === valorPrev)) {
    select.value = valorPrev;
  }
}

function refrescarComms(): void {
  const vhfList = document.getElementById('vhfMessages') as HTMLDivElement | null;
  const navList = document.getElementById('navtexMessages') as HTMLDivElement | null;
  const dmList = document.getElementById('dmMessages') as HTMLDivElement | null;
  if (vhfList) {
    vhfList.innerHTML = mensajesVHF
      .slice(-50)
      .map((m) => `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> <strong>${escapeHtml(m.remitenteNombre)}:</strong> ${escapeHtml(m.texto)}</div>`)
      .join('');
    vhfList.scrollTop = vhfList.scrollHeight;
  }
  if (navList) {
    navList.innerHTML = mensajesNavtex
      .slice(-30)
      .map((m) => `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> ${escapeHtml(m.texto)}</div>`)
      .join('');
    navList.scrollTop = navList.scrollHeight;
  }
  if (dmList) {
    dmList.innerHTML = mensajesPrivados
      .slice(-30)
      .map((m) => {
        const direccion = m.deUserId === userId ? 'Yo →' : '← Alumno';
        return `<div class="comm-item"><span class="comm-time">${formatHora(m.ts)}</span> <em>${direccion}</em> ${escapeHtml(m.texto)}</div>`;
      })
      .join('');
    dmList.scrollTop = dmList.scrollHeight;
  }
}

function formatHora(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}

async function loadCarta(): Promise<void> {
  // Cargamos los detalles del escenario para obtener el id (ya tenemos
  // el escenarioId desde loadSesion vía la API). Usamos el detalle de la sesión
  // que ya devuelve los datos relevantes.
  const res = await fetch(`/api/sesiones/${sesionId}`, { credentials: 'include' });
  if (!res.ok) return;
  const { sesion } = (await res.json()) as { sesion: Sesion };
  const escRes = await fetch(`/api/escenarios/${sesion.escenarioId}`, { credentials: 'include' });
  if (!escRes.ok) {
    showError('No se pudo cargar la carta náutica');
    return;
  }
  const { carta } = (await escRes.json()) as { carta: CartaParseada };
  cartaCache = carta;

  const img = new Image();
  img.src = carta.rasterUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo cargar el PNG de la carta'));
  });
  imagenCache = img;

  cartaInfo.textContent =
    `${img.naturalWidth}×${img.naturalHeight} px · ` +
    `${carta.anchoMillas.toFixed(2)}×${carta.altoMillas.toFixed(2)} millas · ` +
    `NW: ${formatCoord(carta.esquinaNW.lat, carta.esquinaNW.lon)} · ` +
    `SE: ${formatCoord(carta.esquinaSE.lat, carta.esquinaSE.lon)} · ` +
    `${carta.segmentos.length.toLocaleString('es-AR')} segmentos`;

  loadingMsg.hidden = true;
  canvas.hidden = false;
  redraw();
}

async function loadParticipaciones(): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}/participaciones`, { credentials: 'include' });
  if (!res.ok) {
    alumnosLista.innerHTML = `<p class="auth-error">Error cargando alumnos</p>`;
    return;
  }
  const { participaciones } = (await res.json()) as { participaciones: Participacion[] };
  participacionesActuales = participaciones;
  refrescarDmDestinos();
  if (participaciones.length === 0) {
    alumnosLista.innerHTML = `<p class="placeholder">Todavía no hay alumnos asignados a esta sesión.</p>`;
    return;
  }
  alumnosLista.innerHTML = '';
  for (const p of participaciones) {
    const row = document.createElement('div');
    row.className = 'alumno-row';
    const puedeQuitar = sesionEstado !== 'finalizada';
    row.innerHTML = `
      <span class="ownship-tag">OS-${p.ownshipIndex}</span>
      <span class="alumno-info">
        <strong>${escape(p.alumnoNombre)}</strong>
        <small>${escape(p.alumnoEmail)}</small>
      </span>
      ${puedeQuitar ? `<button type="button" class="btn-quitar" data-id="${p.id}">Quitar</button>` : ''}
    `;
    alumnosLista.appendChild(row);
  }
  alumnosLista.querySelectorAll('.btn-quitar').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = Number((e.currentTarget as HTMLButtonElement).dataset.id);
      if (!id) return;
      await fetch(`/api/sesiones/${sesionId}/participaciones/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await Promise.all([loadParticipaciones(), loadAlumnosDisponibles()]);
    });
  });
}

async function loadAlumnosDisponibles(): Promise<void> {
  const res = await fetch(`/api/sesiones/${sesionId}/alumnos-disponibles`, { credentials: 'include' });
  if (!res.ok) return;
  const { alumnos } = (await res.json()) as { alumnos: Pick<PublicUser, 'id' | 'email' | 'nombre'>[] };
  // Limpiar select manteniendo solo el placeholder.
  while (addAlumnoSelect.options.length > 1) addAlumnoSelect.remove(1);
  for (const a of alumnos) {
    const opt = document.createElement('option');
    opt.value = String(a.id);
    opt.textContent = `${a.nombre} (${a.email})`;
    addAlumnoSelect.appendChild(opt);
  }
  // Desactivar el form si la sesión está finalizada.
  const finalizada = sesionEstado === 'finalizada';
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

btnAbrir.addEventListener('click', async () => {
  if (!confirm('¿Abrir la sesión? Los alumnos asignados van a poder entrar.')) return;
  const res = await fetch(`/api/sesiones/${sesionId}/abrir`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    alert(err.error ?? 'No se pudo abrir');
    return;
  }
  await loadSesion();
  await Promise.all([loadParticipaciones(), loadAlumnosDisponibles()]);
});

btnCerrar.addEventListener('click', async () => {
  if (!confirm('¿Cerrar la sesión? Los alumnos van a perder el acceso.')) return;
  const res = await fetch(`/api/sesiones/${sesionId}/cerrar`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    alert(err.error ?? 'No se pudo cerrar');
    return;
  }
  await loadSesion();
  await Promise.all([loadParticipaciones(), loadAlumnosDisponibles()]);
});

btnPausar.addEventListener('click', async () => {
  const res = await fetch(`/api/sesiones/${sesionId}/pausar`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    alert(err.error ?? 'No se pudo pausar');
  }
});

btnReanudar.addEventListener('click', async () => {
  const res = await fetch(`/api/sesiones/${sesionId}/reanudar`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    alert(err.error ?? 'No se pudo reanudar');
  }
});

function redraw(): void {
  if (!cartaCache || !imagenCache) return;
  const img = imagenCache;
  const dpr = window.devicePixelRatio || 1;
  const containerWidth = canvas.parentElement!.clientWidth - 4;
  const escala = Math.min(1, containerWidth / img.naturalWidth);
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

  if (toggleSegmentos.checked) {
    const { esquinaNW, esquinaSE, anchoMillas, altoMillas } = cartaCache;
    const anchoPix = esquinaSE.px - esquinaNW.px;
    const altoPix = esquinaSE.py - esquinaNW.py;
    const xMillaApix = anchoPix / anchoMillas;
    const yMillaApix = altoPix / altoMillas;
    const millasToPx = (xMill: number, yMill: number): [number, number] => [
      esquinaNW.px + xMill * xMillaApix,
      esquinaSE.py - yMill * yMillaApix,
    ];

    ctx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
    ctx.lineWidth = 1.5 / escala;
    ctx.beginPath();
    for (const seg of cartaCache.segmentos) {
      const [x1, y1] = millasToPx(seg.xMillas1, seg.yMillas1);
      const [x2, y2] = millasToPx(seg.xMillas2, seg.yMillas2);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }

  // Render en vivo de los buques de la sesión (si hay tick reciente).
  if (ultimoTick) {
    for (const b of ultimoTick.buques) {
      dibujarBuque(ctx, escala, b);
    }
  }
}

function dibujarBuque(ctx: CanvasRenderingContext2D, escala: number, b: EstadoBuqueDTO): void {
  if (!cartaCache) return;
  const { esquinaNW, esquinaSE } = cartaCache;
  const fx = (b.lon - esquinaNW.lon) / (esquinaSE.lon - esquinaNW.lon);
  const fy = (esquinaNW.lat - b.lat) / (esquinaNW.lat - esquinaSE.lat);
  const px = esquinaNW.px + fx * (esquinaSE.px - esquinaNW.px);
  const py = esquinaNW.py + fy * (esquinaSE.py - esquinaNW.py);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate((b.headingDeg * Math.PI) / 180);
  const r = 10 / escala;
  ctx.fillStyle = 'rgba(0, 220, 140, 0.95)';
  ctx.strokeStyle = '#003322';
  ctx.lineWidth = 1.5 / escala;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.6);
  ctx.lineTo(r, r);
  ctx.lineTo(-r, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (Math.abs(b.velocidadKn) > 0.1) {
    const largo = Math.min(80, Math.abs(b.velocidadKn) * 2.5) / escala;
    const sentido = b.velocidadKn >= 0 ? -1 : 1;
    ctx.strokeStyle = 'rgba(0, 220, 140, 0.7)';
    ctx.lineWidth = 1.5 / escala;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, sentido * largo);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = 'rgba(0, 220, 140, 1)';
  ctx.font = `${13 / escala}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`OS-${b.ownshipIndex} · ${b.headingDeg.toFixed(0)}° · ${b.velocidadKn.toFixed(1)}kn`, px, py + 14 / escala);
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

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}

toggleSegmentos.addEventListener('change', redraw);
window.addEventListener('resize', redraw);
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
