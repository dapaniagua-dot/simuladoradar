import type { LoginResponse, ApiError } from '../shared/types.js';

const form = document.getElementById('loginForm') as HTMLFormElement;
const errorEl = document.getElementById('loginError') as HTMLParagraphElement;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const data = new FormData(form);
  const body = {
    email: String(data.get('email') ?? '').trim(),
    password: String(data.get('password') ?? ''),
  };
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json()) as ApiError;
      errorEl.textContent = err.error ?? 'No se pudo ingresar';
      errorEl.hidden = false;
      return;
    }
    const { user } = (await res.json()) as LoginResponse;
    if (user.role === 'admin') {
      location.href = '/admin.html';
    } else {
      location.href = '/dashboard.html';
    }
  } catch {
    errorEl.textContent = 'Error de conexión con el servidor';
    errorEl.hidden = false;
  }
});
