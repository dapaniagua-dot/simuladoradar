import type { CartaParseada, LoginResponse, Sesion } from '../shared/types.js';

const userBadge = document.getElementById('userBadge') as HTMLSpanElement;
const titulo = document.getElementById('sesionTitulo') as HTMLHeadingElement;
const cartaNombre = document.getElementById('cartaNombre') as HTMLSpanElement;
const estadoBadge = document.getElementById('estadoBadge') as HTMLSpanElement;
const descripcionEl = document.getElementById('descripcionEl') as HTMLParagraphElement;
const cartaInfo = document.getElementById('cartaInfo') as HTMLSpanElement;
const loadingMsg = document.getElementById('loadingMsg') as HTMLDivElement;
const canvas = document.getElementById('cartaCanvas') as HTMLCanvasElement;
const toggleSegmentos = document.getElementById('toggleSegmentos') as HTMLInputElement;

let cartaCache: CartaParseada | null = null;
let imagenCache: HTMLImageElement | null = null;

async function init(): Promise<void> {
  const me = await fetch('/api/auth/me', { credentials: 'include' });
  if (!me.ok) {
    location.href = '/login.html';
    return;
  }
  const { user } = (await me.json()) as LoginResponse;
  userBadge.textContent = `${user.nombre} (${user.role})`;

  const params = new URLSearchParams(location.search);
  const id = Number(params.get('id'));
  if (!Number.isFinite(id) || id <= 0) {
    showError('Falta el ID de la sesión en la URL');
    return;
  }

  const res = await fetch(`/api/sesiones/${id}`, { credentials: 'include' });
  if (!res.ok) {
    showError('No se pudo cargar la sesión');
    return;
  }
  const { sesion } = (await res.json()) as { sesion: Sesion };
  titulo.textContent = sesion.nombre;
  cartaNombre.textContent = sesion.escenarioNombre;
  estadoBadge.textContent = sesion.estado;
  estadoBadge.className = `badge badge-${sesion.estado}`;
  if (sesion.descripcion) {
    descripcionEl.textContent = sesion.descripcion;
  }

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

function redraw(): void {
  if (!cartaCache || !imagenCache) return;
  const img = imagenCache;

  // Ajustar el canvas al tamaño del viewport disponible, manteniendo la relación de aspecto.
  // El raster de Mar del Plata es ~2400×3600 — lo escalamos a ancho útil del contenedor.
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
    // Convertimos cada segmento de su sistema nativo (millas náuticas) a
    // pixeles del raster usando la calibración por corners. El motor del radar
    // de Melipal opera en millas; nosotros sólo necesitamos pintarlos arriba
    // del PNG así que mapeamos linealmente al rectángulo de la carta.
    const { esquinaNW, esquinaSE, anchoMillas, altoMillas } = cartaCache;
    const anchoPix = esquinaSE.px - esquinaNW.px;
    const altoPix = esquinaSE.py - esquinaNW.py;
    const xMillaApix = anchoPix / anchoMillas;
    const yMillaApix = altoPix / altoMillas;

    const millasToPx = (xMill: number, yMill: number): [number, number] => {
      // X = millas al este desde NW → crece hacia la derecha
      // Y = millas al norte desde SE → crece hacia arriba (los pixeles crecen hacia abajo)
      const px = esquinaNW.px + xMill * xMillaApix;
      const py = esquinaSE.py - yMill * yMillaApix;
      return [px, py];
    };

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

toggleSegmentos.addEventListener('change', redraw);
window.addEventListener('resize', redraw);
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/login.html';
});

void init();
