import type {
  ApiError,
  CreateSesionRequest,
  Escenario,
  LoginResponse,
  Sesion,
} from '../shared/types.js';

const userBadge = document.getElementById('userBadge') as HTMLSpanElement;
const form = document.getElementById('createSesionForm') as HTMLFormElement;
const errorEl = document.getElementById('createError') as HTMLParagraphElement;
const escenarioSelect = form.elements.namedItem('escenarioId') as HTMLSelectElement;
const tbody = document.querySelector('#sesionesTable tbody') as HTMLTableSectionElement;

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
  await Promise.all([loadEscenarios(), loadSesiones()]);
}

async function loadEscenarios(): Promise<void> {
  const res = await fetch('/api/escenarios', { credentials: 'include' });
  if (!res.ok) {
    return;
  }
  const { escenarios } = (await res.json()) as { escenarios: Escenario[] };
  for (const esc of escenarios) {
    const opt = document.createElement('option');
    opt.value = String(esc.id);
    opt.textContent = esc.nombre;
    escenarioSelect.appendChild(opt);
  }
  if (escenarios.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No hay cartas disponibles — pedí al admin que cargue una';
    opt.disabled = true;
    escenarioSelect.appendChild(opt);
  }
}

async function loadSesiones(): Promise<void> {
  const res = await fetch('/api/sesiones', { credentials: 'include' });
  if (!res.ok) {
    tbody.innerHTML = `<tr><td colspan="5" class="placeholder">Error cargando sesiones</td></tr>`;
    return;
  }
  const { sesiones } = (await res.json()) as { sesiones: Sesion[] };
  if (sesiones.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="placeholder">Todavía no creaste ninguna sesión.</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  for (const s of sesiones) {
    const tr = document.createElement('tr');
    const fecha = new Date(s.createdAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    tr.innerHTML = `
      <td>${escape(s.nombre)}</td>
      <td>${escape(s.escenarioNombre)}</td>
      <td><span class="badge badge-${s.estado}">${s.estado}</span></td>
      <td>${fecha}</td>
      <td><a href="/sesion.html?id=${s.id}">Ver carta</a></td>
    `;
    tbody.appendChild(tr);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const data = new FormData(form);
  const escenarioIdRaw = String(data.get('escenarioId') ?? '');
  if (!escenarioIdRaw) {
    errorEl.textContent = 'Tenés que elegir una carta náutica';
    errorEl.hidden = false;
    return;
  }
  const body: CreateSesionRequest = {
    nombre: String(data.get('nombre') ?? '').trim(),
    descripcion: String(data.get('descripcion') ?? '').trim() || undefined,
    escenarioId: Number(escenarioIdRaw),
  };
  const res = await fetch('/api/sesiones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    errorEl.textContent = err.error ?? 'No se pudo crear la sesión';
    errorEl.hidden = false;
    return;
  }
  form.reset();
  await loadSesiones();
});

document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}

void init();
