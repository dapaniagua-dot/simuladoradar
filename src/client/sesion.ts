import type {
  ApiError,
  CartaParseada,
  LoginResponse,
  Participacion,
  PublicUser,
  Sesion,
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
const btnCerrar = document.getElementById('btnCerrar') as HTMLButtonElement;
const alumnosLista = document.getElementById('alumnosLista') as HTMLDivElement;
const addAlumnoForm = document.getElementById('addAlumnoForm') as HTMLFormElement;
const addAlumnoSelect = addAlumnoForm.elements.namedItem('alumnoId') as HTMLSelectElement;
const addAlumnoError = document.getElementById('addAlumnoError') as HTMLParagraphElement;

let sesionId = 0;
let sesionEstado: Sesion['estado'] = 'preparada';
let cartaCache: CartaParseada | null = null;
let imagenCache: HTMLImageElement | null = null;

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
