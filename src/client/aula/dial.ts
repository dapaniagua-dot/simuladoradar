// Componente reutilizable de dial analógico (SVG) usado para Rudder Command,
// Rudder Angle, Turn Rate, Wind Speed y Wind Direction.
//
// Diseño visual minimal a propósito: un círculo con marcas, etiqueta arriba,
// valor numérico debajo, y una aguja que rota. El estilo bonito lo agrega
// Diego después con Claude Design.

export interface DialOptions {
  label: string;
  unit?: string;
  // Rango del dial. Si min < 0 < max, el cero queda al centro (apuntando arriba).
  // Si min === 0 (ej. wind speed 0..50), 0 queda en la izquierda y max a la derecha.
  min: number;
  max: number;
  // Si "compass" es true, el dial es de 360° (wind direction) y el valor se dibuja
  // como un punto en la circunferencia.
  compass?: boolean;
  // Cantidad de marcas mayores en el arco (default 5). Se usan para etiquetar.
  ticks?: number;
}

export class Dial {
  private svg: SVGSVGElement;
  private needle: SVGGElement;
  private valueText: SVGTextElement;

  constructor(public readonly host: HTMLElement, private opts: DialOptions) {
    host.classList.add('dial');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '-100 -100 200 200');
    this.svg.classList.add('dial-svg');
    host.appendChild(this.svg);

    // Etiqueta arriba
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', '-78');
    label.setAttribute('text-anchor', 'middle');
    label.classList.add('dial-label');
    label.textContent = opts.label;
    this.svg.appendChild(label);

    // Círculo de fondo
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bg.setAttribute('cx', '0');
    bg.setAttribute('cy', '0');
    bg.setAttribute('r', '70');
    bg.classList.add('dial-bg');
    this.svg.appendChild(bg);

    // Marcas mayores
    this.dibujarMarcas();

    // Aguja (en grupo para rotarla)
    this.needle = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.needle.classList.add('dial-needle');
    const aguja = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    aguja.setAttribute('x1', '0');
    aguja.setAttribute('y1', '12');
    aguja.setAttribute('x2', '0');
    aguja.setAttribute('y2', '-58');
    this.needle.appendChild(aguja);
    const centro = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    centro.setAttribute('r', '5');
    this.needle.appendChild(centro);
    this.svg.appendChild(this.needle);

    // Valor numérico al pie
    this.valueText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    this.valueText.setAttribute('x', '0');
    this.valueText.setAttribute('y', '92');
    this.valueText.setAttribute('text-anchor', 'middle');
    this.valueText.classList.add('dial-value');
    this.svg.appendChild(this.valueText);

    this.setValue(opts.min);
  }

  setValue(v: number): void {
    const clamped = Math.max(this.opts.min, Math.min(this.opts.max, v));
    const angle = this.opts.compass
      ? clamped // 0 = norte (arriba), 90 = este, etc.
      : this.mapearAEjeCentral(clamped);
    this.needle.setAttribute('transform', `rotate(${angle})`);
    const fmt = Math.abs(clamped) >= 100 ? clamped.toFixed(0) : clamped.toFixed(1);
    this.valueText.textContent = `${fmt}${this.opts.unit ? ' ' + this.opts.unit : ''}`;
  }

  // Mapea valor al ángulo del dial. Para rangos simétricos (-X..+X), el centro
  // del rango cae arriba (0°) y los extremos a -135° / +135°.
  private mapearAEjeCentral(v: number): number {
    const { min, max } = this.opts;
    const span = max - min;
    if (span <= 0) return 0;
    const norm = (v - min) / span; // 0..1
    // -135° (extremo izq) a +135° (extremo der)
    return -135 + norm * 270;
  }

  private dibujarMarcas(): void {
    const ticks = this.opts.ticks ?? 5;
    for (let i = 0; i <= ticks; i++) {
      const norm = i / ticks;
      const angle = this.opts.compass ? norm * 360 : -135 + norm * 270;
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', '0');
      tick.setAttribute('y1', '-65');
      tick.setAttribute('x2', '0');
      tick.setAttribute('y2', '-72');
      tick.setAttribute('transform', `rotate(${angle})`);
      tick.classList.add('dial-tick');
      this.svg.appendChild(tick);

      // Etiqueta del tick
      const valor = this.opts.compass
        ? Math.round(norm * 360)
        : Math.round(this.opts.min + norm * (this.opts.max - this.opts.min));
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      const rad = ((angle - 90) * Math.PI) / 180;
      label.setAttribute('x', String(Math.cos(rad) * 56));
      label.setAttribute('y', String(Math.sin(rad) * 56 + 4));
      label.setAttribute('text-anchor', 'middle');
      label.classList.add('dial-tick-label');
      label.textContent = String(valor);
      this.svg.appendChild(label);
    }
  }
}
