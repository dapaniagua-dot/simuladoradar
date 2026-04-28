import type { CreateUserRequest, LoginResponse, PublicUser, ApiError } from '../shared/types.js';

const userBadge = document.getElementById('userBadge') as HTMLSpanElement;
const form = document.getElementById('createUserForm') as HTMLFormElement;
const errorEl = document.getElementById('createError') as HTMLParagraphElement;
const tbody = document.querySelector('#usersTable tbody') as HTMLTableSectionElement;

async function init(): Promise<void> {
  const me = await fetch('/api/auth/me', { credentials: 'include' });
  if (!me.ok) {
    location.href = '/login.html';
    return;
  }
  const { user } = (await me.json()) as LoginResponse;
  if (user.role !== 'admin') {
    location.href = '/dashboard.html';
    return;
  }
  userBadge.textContent = `${user.nombre} (admin)`;
  await refreshUsers();
}

async function refreshUsers(): Promise<void> {
  const res = await fetch('/api/admin/users', { credentials: 'include' });
  if (!res.ok) return;
  const { users } = (await res.json()) as { users: PublicUser[] };
  tbody.innerHTML = '';
  for (const u of users) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${u.id}</td><td>${u.email}</td><td>${u.nombre}</td><td>${u.role}</td>`;
    tbody.appendChild(row);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const data = new FormData(form);
  const body: CreateUserRequest = {
    email: String(data.get('email') ?? '').trim(),
    nombre: String(data.get('nombre') ?? '').trim(),
    password: String(data.get('password') ?? ''),
    role: data.get('role') as CreateUserRequest['role'],
  };
  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json()) as ApiError;
    errorEl.textContent = err.error ?? 'No se pudo crear el usuario';
    errorEl.hidden = false;
    return;
  }
  form.reset();
  await refreshUsers();
});

document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
