import type { LoginResponse, SesionDelAlumno } from '../shared/types.js';

async function init(): Promise<void> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  if (!res.ok) {
    location.href = '/login.html';
    return;
  }
  const { user } = (await res.json()) as LoginResponse;
  const badge = document.getElementById('userBadge') as HTMLSpanElement;
  badge.textContent = `${user.nombre} (${user.role})`;

  if (user.role === 'admin') {
    location.href = '/admin.html';
    return;
  }
  if (user.role === 'profesor') {
    document.getElementById('profesorView')!.hidden = false;
    return;
  }

  // Vista del alumno: cargar sesiones abiertas en las que está asignado.
  document.getElementById('alumnoView')!.hidden = false;
  await cargarMisSesiones();

  // Polling cada 10 segundos para detectar cuando el profesor abre una sesión.
  // En MVP 5 (multiplayer sincrónico) esto se reemplaza por un evento WebSocket.
  setInterval(() => void cargarMisSesiones(), 10000);

  document.getElementById('logoutBtn')!.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    location.href = '/login.html';
  });
}

async function cargarMisSesiones(): Promise<void> {
  const res = await fetch('/api/sesiones/mis-sesiones', { credentials: 'include' });
  if (!res.ok) return;
  const { sesiones } = (await res.json()) as { sesiones: SesionDelAlumno[] };
  const lista = document.getElementById('sesionesAbiertas') as HTMLDivElement;
  const sinSesiones = document.getElementById('sinSesionesMsg') as HTMLParagraphElement;
  if (sesiones.length === 0) {
    lista.innerHTML = '';
    sinSesiones.hidden = false;
    return;
  }
  sinSesiones.hidden = true;
  lista.innerHTML = '';
  for (const s of sesiones) {
    const card = document.createElement('div');
    card.className = 'sesion-card';
    const desde = s.openedAt
      ? new Date(s.openedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
      : '—';
    card.innerHTML = `
      <div class="sesion-card-body">
        <h3>${escape(s.nombre)}</h3>
        <p><strong>Carta:</strong> ${escape(s.escenarioNombre)}</p>
        <p><strong>Tu buque:</strong> OS-${s.ownshipIndex} &nbsp;·&nbsp; <strong>Abierta desde:</strong> ${desde}</p>
        ${s.descripcion ? `<p class="placeholder">${escape(s.descripcion)}</p>` : ''}
      </div>
      <a class="link-button" href="/aula.html?sesion=${s.id}">Entrar</a>
    `;
    lista.appendChild(card);
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}

void init();
