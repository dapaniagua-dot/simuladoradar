// Telégrafo doble del Melipal: una palanca por máquina (babor a la izquierda,
// estribor a la derecha) con la escala original en el medio.
//
// Usa los gráficos originales: cada palanca tiene 10 fotogramas (uno por
// posición) y se "mueve" cambiando la imagen, igual que en el Melipal.
// El alumno arrastra cada palanca por separado, o hace click en la escala
// para mover las dos juntas a esa posición.

import type { TelegrafoId } from '../../shared/types.js';

export type Maquina = 'babor' | 'estribor';

export interface TelegrafoPosicion {
  id: TelegrafoId;
  label: string;
}

// Orden de los fotogramas y de la escala: índice 0 arriba (Full Ahead) → 9
// abajo (Full Astern).
export const POSICIONES: TelegrafoPosicion[] = [
  { id: 'FAH',  label: 'FULL AHEAD' },
  { id: 'MAN',  label: 'MANOEUVRING' },
  { id: 'HAH',  label: 'HALF AHEAD' },
  { id: 'SAH',  label: 'SLOW AHEAD' },
  { id: 'DSAH', label: 'DEAD SLOW AHEAD' },
  { id: 'STOP', label: 'STOP' },
  { id: 'DSAS', label: 'DEAD SLOW ASTERN' },
  { id: 'SAS',  label: 'SLOW ASTERN' },
  { id: 'HAS',  label: 'HALF ASTERN' },
  { id: 'FAS',  label: 'FULL ASTERN' },
];

// Altura (en px del gráfico original de 290) del centro de cada etiqueta de la
// escala. No están equiespaciadas, por eso se miden en vez de calcularse.
const Y_ESCALA = [45.5, 60.5, 75.5, 95, 117.5, 144, 174, 201, 222.5, 239];
const ALTO_GRAFICO = 290;

const IDX_STOP = POSICIONES.findIndex((p) => p.id === 'STOP');

function srcPalanca(maquina: Maquina, idx: number): string {
  return `/img/consola/palanca-${maquina}-${idx}.png`;
}

export class Telegrafo {
  private palancas: Record<Maquina, HTMLImageElement>;
  private actual: Record<Maquina, number> = { babor: IDX_STOP, estribor: IDX_STOP };
  private arrastrando: Maquina | null = null;

  constructor(host: HTMLElement, private onChange: (maquina: Maquina, id: TelegrafoId) => void) {
    host.classList.add('telegrafo');
    host.innerHTML = `
      <img class="telegrafo-palanca" data-maquina="babor" src="${srcPalanca('babor', IDX_STOP)}"
           alt="" draggable="false" tabindex="0" role="slider"
           aria-label="Telégrafo máquina de babor" aria-valuemin="0" aria-valuemax="${POSICIONES.length - 1}">
      <img class="telegrafo-escala" src="/img/consola/telegrafo-escala.png" alt="" draggable="false">
      <img class="telegrafo-palanca" data-maquina="estribor" src="${srcPalanca('estribor', IDX_STOP)}"
           alt="" draggable="false" tabindex="0" role="slider"
           aria-label="Telégrafo máquina de estribor" aria-valuemin="0" aria-valuemax="${POSICIONES.length - 1}">
    `;
    const [babor, escala, estribor] = host.querySelectorAll('img');
    this.palancas = { babor: babor as HTMLImageElement, estribor: estribor as HTMLImageElement };

    // Precargar los 20 fotogramas para que la palanca no parpadee al moverla.
    for (const m of ['babor', 'estribor'] as const) {
      for (let i = 0; i < POSICIONES.length; i++) new Image().src = srcPalanca(m, i);
    }

    for (const maquina of ['babor', 'estribor'] as const) {
      const img = this.palancas[maquina];
      img.addEventListener('pointerdown', (e) => {
        this.arrastrando = maquina;
        img.setPointerCapture(e.pointerId);
        this.moverA(maquina, this.indiceEnY(img, e.clientY));
      });
      img.addEventListener('pointermove', (e) => {
        if (this.arrastrando === maquina) this.moverA(maquina, this.indiceEnY(img, e.clientY));
      });
      img.addEventListener('pointerup', () => { this.arrastrando = null; });
      img.addEventListener('pointercancel', () => { this.arrastrando = null; });
      img.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') this.moverA(maquina, this.actual[maquina] - 1);
        else if (e.key === 'ArrowDown') this.moverA(maquina, this.actual[maquina] + 1);
        else return;
        e.preventDefault();
      });
      this.pintar(maquina);
    }

    // Click en la escala: las dos máquinas a la misma posición.
    escala!.addEventListener('click', (e) => {
      const idx = this.indiceEnY(escala as HTMLImageElement, e.clientY);
      this.moverA('babor', idx);
      this.moverA('estribor', idx);
    });
  }

  // Sincroniza desde el server sin emitir. Si el alumno está arrastrando esa
  // palanca, se ignora para que no "pelee" con el mouse.
  set(maquina: Maquina, id: TelegrafoId): void {
    if (this.arrastrando === maquina) return;
    const idx = POSICIONES.findIndex((p) => p.id === id);
    if (idx < 0 || idx === this.actual[maquina]) return;
    this.actual[maquina] = idx;
    this.pintar(maquina);
  }

  private moverA(maquina: Maquina, idx: number): void {
    const clamped = Math.max(0, Math.min(POSICIONES.length - 1, idx));
    if (clamped === this.actual[maquina]) return;
    this.actual[maquina] = clamped;
    this.pintar(maquina);
    this.onChange(maquina, POSICIONES[clamped]!.id);
  }

  private pintar(maquina: Maquina): void {
    const idx = this.actual[maquina];
    const img = this.palancas[maquina];
    img.src = srcPalanca(maquina, idx);
    img.setAttribute('aria-valuenow', String(idx));
    img.setAttribute('aria-valuetext', POSICIONES[idx]!.label);
    img.title = `${maquina === 'babor' ? 'Babor' : 'Estribor'}: ${POSICIONES[idx]!.label}`;
  }

  // Posición de la escala más cercana a una coordenada Y de pantalla. Se
  // normaliza con el alto real del elemento, así funciona con la consola
  // escalada a cualquier tamaño.
  private indiceEnY(el: HTMLElement, clientY: number): number {
    const rect = el.getBoundingClientRect();
    const y = ((clientY - rect.top) / rect.height) * ALTO_GRAFICO;
    let mejor = 0;
    for (let i = 1; i < Y_ESCALA.length; i++) {
      if (Math.abs(Y_ESCALA[i]! - y) < Math.abs(Y_ESCALA[mejor]! - y)) mejor = i;
    }
    return mejor;
  }
}
