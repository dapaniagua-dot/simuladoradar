import type { LoginResponse } from '../shared/types.js';

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
  } else {
    document.getElementById('alumnoView')!.hidden = false;
  }

  document.getElementById('logoutBtn')!.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    location.href = '/login.html';
  });
}

void init();
