import type { CartaParseada, LoginResponse } from '../shared/types.js';

interface AulaPayload {
  sesion: {
    id: number;
    nombre: string;
    descripcion: string | null;
    escenarioNombre: string;
    ownshipIndex: number;
  };
  carta: CartaParseada;
}

const userBadge = document.getElementById('userBadge') as HTMLSpanElement;
const titulo = document.getElementById('sesionTitulo') as HTMLHeadingElement;
const cartaNombre = document.getElementById('cartaNombre') as HTMLSpanElement;
const ownshipBadge = document.getElementById('ownshipBadge') as HTMLSpanElement;
const descripcionEl = document.getElementById('descripcionEl') as HTMLParagraphElement;
const cartaInfo = document.getElementById('cartaInfo') as HTMLSpanElement;
const loadingMsg = document.getElementById('loadingMsg') as HTMLDivElement;
const canvas = document.getElementById('cartaCanvas') as HTMLCanvasElement;

let cartaCache: CartaParseada | null = null;
let imagenCache: HTMLImageElement | null = null;

async function init(): Promise<void> {
  const meRes = await fetch('/api/auth/me', { credentials: 'include' });
  if (!meRes.ok) {
    location.href = '/login.html';
    return;
  }
  const { user } = (await meRes.json()) as LoginResponse;
  if (user.role !== 'alumno') {
    location.href = '/dashboard.html';
    return;
  }
  userBadge.textContent = `${user.nombre} (${user.role})`;

  const params = new URLSearchParams(location.search);
  const sesionId = Number(params.get('sesion'));
  if (!Number.isFinite(sesionId) || sesionId <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  const res = await fetch(`/api/aula/${sesionId}`, { credentials: 'include' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    showError(err.error ?? 'No se pudo entrar a la sesión');
    return;
  }
  const { sesion, carta } = (await res.json()) as AulaPayload;

  titulo.textContent = sesion.nombre;
  cartaNombre.textContent = sesion.escenarioNombre;
  ownshipBadge.textContent = `OS-${sesion.ownshipIndex}`;
  ownshipBadge.classList.add('badge-abierta');
  if (sesion.descripcion) {
    descripcionEl.textContent = sesion.descripcion;
  }
  cartaCache = carta;

  const img = new Image();
  img.src = carta.rasterUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo cargar el PNG de la carta'));
  });
  imagenCache = img;

  cartaInfo.textContent = `${img.naturalWidth}×${img.naturalHeight} px · ${carta.anchoMillas.toFixed(2)}×${carta.altoMillas.toFixed(2)} millas`;

  loadingMsg.hidden = true;
  canvas.hidden = false;
  redraw();
}

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
}

function showError(msg: string): void {
  loadingMsg.textContent = msg;
  loadingMsg.classList.remove('placeholder');
  loadingMsg.classList.add('auth-error');
}

window.addEventListener('resize', redraw);
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
