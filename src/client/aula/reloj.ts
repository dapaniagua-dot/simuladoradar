// Reloj analógico del Melipal: la esfera es el gráfico original (205x205) y
// encima dibujamos la aguja en SVG y el valor en la ventanita negra.
//
// Cada reloj define cómo se traduce su valor a un ángulo, porque las escalas
// originales no son todas iguales (el timón tiene el 0 abajo, el turn rate
// arriba, el viento empieza abajo a la izquierda…).

const SVG_NS = 'http://www.w3.org/2000/svg';

// Centro del eje de la aguja, medido sobre las esferas originales.
const CX = 103;
const CY = 105.5;

export interface RelojOpciones {
  imagen: string;
  // Ángulo de la aguja en grados, sentido horario desde las 12.
  angulo: (valor: number) => number;
  // Texto de la ventanita de valor; si no hay ventanita, se omite.
  texto?: (valor: number) => string;
  // Ventanita de valor sobre la esfera (px del gráfico original).
  ventanita?: { x: number; y: number; w: number; h: number };
  // En vez de aguja, un marcador sobre el aro (rosa de viento).
  marcadorEnAro?: boolean;
  largoAguja?: number;
}

export class Reloj {
  private aguja: SVGGElement;
  private valorEl: HTMLElement | null = null;

  constructor(host: HTMLElement, private opts: RelojOpciones) {
    host.classList.add('reloj');
    const img = document.createElement('img');
    img.src = opts.imagen;
    img.alt = '';
    img.draggable = false;
    img.className = 'reloj-esfera';
    host.appendChild(img);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 205 205');
    svg.classList.add('reloj-svg');
    this.aguja = document.createElementNS(SVG_NS, 'g');
    this.aguja.classList.add('reloj-aguja');
    if (opts.marcadorEnAro) {
      // Triángulo apuntando al centro, sobre el aro de la rosa.
      const tri = document.createElementNS(SVG_NS, 'path');
      tri.setAttribute('d', `M ${CX} ${CY - 60} l -7 -14 l 14 0 z`);
      this.aguja.appendChild(tri);
    } else {
      const largo = opts.largoAguja ?? 66;
      const linea = document.createElementNS(SVG_NS, 'path');
      linea.setAttribute('d', `M ${CX - 2.5} ${CY + 12} L ${CX} ${CY - largo} L ${CX + 2.5} ${CY + 12} z`);
      this.aguja.appendChild(linea);
      const eje = document.createElementNS(SVG_NS, 'circle');
      eje.setAttribute('cx', String(CX));
      eje.setAttribute('cy', String(CY));
      eje.setAttribute('r', '6');
      this.aguja.appendChild(eje);
    }
    svg.appendChild(this.aguja);
    host.appendChild(svg);

    if (opts.ventanita && opts.texto) {
      const v = opts.ventanita;
      this.valorEl = document.createElement('span');
      this.valorEl.className = 'reloj-valor display-7seg';
      Object.assign(this.valorEl.style, {
        left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px`,
      });
      host.appendChild(this.valorEl);
    }
    this.setValue(0);
  }

  setValue(valor: number): void {
    const ang = this.opts.angulo(valor);
    this.aguja.setAttribute('transform', `rotate(${ang.toFixed(1)} ${CX} ${CY})`);
    if (this.valorEl && this.opts.texto) this.valorEl.textContent = this.opts.texto(valor);
  }
}
