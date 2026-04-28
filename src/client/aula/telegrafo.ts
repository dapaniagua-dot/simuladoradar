// Telégrafo vertical mecánico con palanca arrastrable.
// 10 posiciones (Full Ahead arriba → Full Astern abajo).
// El alumno arrastra la palanca con el mouse/touch; al soltar, hace snap a
// la posición más cercana y dispara el callback onChange.

import type { TelegrafoId } from '../../shared/types.js';

export interface TelegrafoPosicion {
  id: TelegrafoId;
  label: string;
}

// Orden visual: ahead arriba, astern abajo.
export const POSICIONES: TelegrafoPosicion[] = [
  { id: 'FAH',  label: 'FULL AHEAD' },
  { id: 'HAH',  label: 'HALF AHEAD' },
  { id: 'SAH',  label: 'SLOW AHEAD' },
  { id: 'DSAH', label: 'D SLOW AHEAD' },
  { id: 'STOP', label: 'STOP' },
  { id: 'DSAS', label: 'D SLOW ASTERN' },
  { id: 'SAS',  label: 'SLOW ASTERN' },
  { id: 'HAS',  label: 'HALF ASTERN' },
  { id: 'FAS',  label: 'FULL ASTERN' },
];

export class Telegrafo {
  private root: HTMLElement;
  private track: HTMLDivElement;
  private handle: HTMLDivElement;
  private current: TelegrafoId = 'STOP';
  private dragging = false;
  private trackHeightPx = 0;

  constructor(host: HTMLElement, private onChange: (id: TelegrafoId) => void) {
    host.classList.add('telegrafo');
    host.innerHTML = `
      <div class="telegrafo-track">
        <div class="telegrafo-marcas">
          ${POSICIONES.map(
            (p, i) => `
            <div class="telegrafo-marca" data-id="${p.id}" data-idx="${i}">
              <span class="telegrafo-label">${p.label}</span>
              <span class="telegrafo-tick"></span>
            </div>`,
          ).join('')}
        </div>
        <div class="telegrafo-handle" tabindex="0" role="slider"
             aria-valuemin="0" aria-valuemax="${POSICIONES.length - 1}"
             aria-valuenow="${POSICIONES.findIndex((p) => p.id === 'STOP')}"
             aria-label="Telégrafo de máquinas">
          <span class="telegrafo-handle-label">STOP</span>
        </div>
      </div>
    `;
    this.root = host;
    this.track = host.querySelector('.telegrafo-track') as HTMLDivElement;
    this.handle = host.querySelector('.telegrafo-handle') as HTMLDivElement;

    // Click directo en una marca: seleccionar esa posición.
    host.querySelectorAll<HTMLElement>('.telegrafo-marca').forEach((m) => {
      m.addEventListener('click', () => {
        const id = m.dataset.id as TelegrafoId | undefined;
        if (id) this.set(id, true);
      });
    });

    // Drag con mouse/touch
    this.handle.addEventListener('mousedown', (e) => this.startDrag(e.clientY));
    this.handle.addEventListener('touchstart', (e) => {
      if (e.touches[0]) this.startDrag(e.touches[0].clientY);
    });
    window.addEventListener('mousemove', (e) => this.dragTo(e.clientY));
    window.addEventListener('touchmove', (e) => {
      if (this.dragging && e.touches[0]) {
        e.preventDefault();
        this.dragTo(e.touches[0].clientY);
      }
    }, { passive: false });
    window.addEventListener('mouseup', () => this.endDrag());
    window.addEventListener('touchend', () => this.endDrag());

    // Teclado: flechas arriba/abajo
    this.handle.addEventListener('keydown', (e) => {
      const idx = POSICIONES.findIndex((p) => p.id === this.current);
      if (e.key === 'ArrowUp' && idx > 0) {
        this.set(POSICIONES[idx - 1]!.id, true);
        e.preventDefault();
      } else if (e.key === 'ArrowDown' && idx < POSICIONES.length - 1) {
        this.set(POSICIONES[idx + 1]!.id, true);
        e.preventDefault();
      }
    });

    this.posicionarHandle();
  }

  set(id: TelegrafoId, emitir: boolean): void {
    this.current = id;
    const idx = POSICIONES.findIndex((p) => p.id === id);
    const pos = POSICIONES[idx];
    if (!pos) return;
    this.handle.setAttribute('aria-valuenow', String(idx));
    const labelEl = this.handle.querySelector('.telegrafo-handle-label');
    if (labelEl) labelEl.textContent = pos.id;
    this.posicionarHandle();
    // Resaltar la marca activa
    this.root.querySelectorAll('.telegrafo-marca').forEach((m) => {
      m.classList.toggle('activa', (m as HTMLElement).dataset.id === id);
    });
    if (emitir) this.onChange(id);
  }

  // Posiciona el handle en pixeles según la posición actual.
  private posicionarHandle(): void {
    const idx = POSICIONES.findIndex((p) => p.id === this.current);
    if (idx < 0) return;
    const trackRect = this.track.getBoundingClientRect();
    if (trackRect.height > 0) this.trackHeightPx = trackRect.height;
    const margenSuperior = 30;
    const margenInferior = 30;
    const usable = Math.max(60, this.trackHeightPx - margenSuperior - margenInferior);
    const step = usable / (POSICIONES.length - 1);
    const top = margenSuperior + step * idx;
    this.handle.style.top = `${top}px`;
  }

  private startDrag(_y: number): void {
    this.dragging = true;
    this.handle.classList.add('arrastrando');
  }

  private dragTo(clientY: number): void {
    if (!this.dragging) return;
    const trackRect = this.track.getBoundingClientRect();
    const margenSuperior = 30;
    const margenInferior = 30;
    const usable = Math.max(60, trackRect.height - margenSuperior - margenInferior);
    const rel = clientY - trackRect.top - margenSuperior;
    const step = usable / (POSICIONES.length - 1);
    const idx = Math.round(rel / step);
    const clamped = Math.max(0, Math.min(POSICIONES.length - 1, idx));
    const pos = POSICIONES[clamped];
    if (pos && pos.id !== this.current) {
      this.set(pos.id, true);
    }
  }

  private endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.handle.classList.remove('arrastrando');
  }

  // Llamar cuando se redimensiona el contenedor.
  refresh(): void {
    this.posicionarHandle();
  }
}
