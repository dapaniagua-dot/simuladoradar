// Base común de los visores de carta (el Easy Navigator del alumno y la carta
// del instructor): la imagen de la carta con zoom y desplazamiento, la
// conversión entre lat/lon, píxeles de la carta y píxeles de pantalla, y la
// herramienta de medir distancia y marcación.
//
// Cada visor hereda y dibuja encima lo suyo en dibujarEncima().

import type { CartaParseada } from '../../shared/types.js';

export type Herramienta = 'puntero' | 'medir';

export interface InfoMouse {
  lat: number;
  lon: number;
}

const COLOR_MEDICION = '#800080';

export abstract class VistaCarta {
  protected ctx: CanvasRenderingContext2D;
  protected ancho = 0;
  protected alto = 0;
  protected dpr = 1;
  // Vista: punto de la carta (px de la imagen) que queda en el centro del
  // canvas, y escala (px de pantalla por px de la imagen).
  protected centroX: number;
  protected centroY: number;
  protected escala = 1;
  protected escalaMin = 0.1;
  protected mouseCarta: [number, number] | null = null;
  private medicion: { a: [number, number]; b: [number, number] } | null = null;

  herramienta: Herramienta = 'puntero';
  onCambio: () => void = () => {};

  constructor(
    protected canvas: HTMLCanvasElement,
    protected carta: CartaParseada,
    protected imagen: HTMLImageElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.centroX = imagen.naturalWidth / 2;
    this.centroY = imagen.naturalHeight / 2;
    this.cablearMouse();
    // El panel cambia de tamaño (vista principal/secundaria, ventana): la
    // carta se adapta sola.
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
  }

  // ----- Vista -----------------------------------------------------------------
  resize(ajustar = false): void {
    const host = this.canvas.parentElement!;
    this.ancho = host.clientWidth;
    this.alto = host.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.ancho}px`;
    this.canvas.style.height = `${this.alto}px`;
    this.canvas.width = Math.floor(this.ancho * this.dpr);
    this.canvas.height = Math.floor(this.alto * this.dpr);
    // Escala mínima: la carta entera entra en el visor.
    const encaje = Math.min(this.ancho / this.imagen.naturalWidth, this.alto / this.imagen.naturalHeight);
    this.escalaMin = encaje;
    if (ajustar || this.escala < encaje) this.escala = encaje;
    this.dibujar();
  }

  zoom(factor: number, focoPantalla?: [number, number]): void {
    const nueva = Math.max(this.escalaMin, Math.min(8, this.escala * factor));
    if (focoPantalla && this.zoomAlCursor()) {
      // El punto bajo el mouse queda fijo.
      const [fx, fy] = this.pantallaACarta(...focoPantalla);
      this.centroX = fx - (focoPantalla[0] - this.ancho / 2) / nueva;
      this.centroY = fy - (focoPantalla[1] - this.alto / 2) / nueva;
    }
    this.escala = nueva;
    this.despuesDeZoom();
    this.dibujar();
    this.onCambio();
  }

  centrarEn(lat: number, lon: number): void {
    [this.centroX, this.centroY] = this.latLonACarta(lat, lon);
    this.dibujar();
  }

  limpiarMedicion(): void {
    this.medicion = null;
    this.dibujar();
  }

  // Ganchos para las subclases.
  protected zoomAlCursor(): boolean { return true; }
  protected despuesDeZoom(): void {}
  // Devuelve true si la subclase se hizo cargo del click (no se arrastra la carta).
  protected alPresionar(_x: number, _y: number): boolean { return false; }
  protected alMover(_x: number, _y: number, _botonApretado: boolean): void {}
  protected alSoltar(): void {}
  protected alArrastrarCarta(dx: number, dy: number, inicio: { cx: number; cy: number }): void {
    this.centroX = inicio.cx - dx / this.escala;
    this.centroY = inicio.cy - dy / this.escala;
  }
  protected alDobleClick(_x: number, _y: number): void {}
  protected alMoverMouse(_info: InfoMouse | null): void {}

  // ----- Coordenadas -------------------------------------------------------------
  latLonACarta(lat: number, lon: number): [number, number] {
    const { esquinaNW: nw, esquinaSE: se } = this.carta;
    return [
      nw.px + ((lon - nw.lon) / (se.lon - nw.lon)) * (se.px - nw.px),
      nw.py + ((nw.lat - lat) / (nw.lat - se.lat)) * (se.py - nw.py),
    ];
  }

  cartaALatLon(x: number, y: number): [number, number] {
    const { esquinaNW: nw, esquinaSE: se } = this.carta;
    return [
      nw.lat - ((y - nw.py) / (se.py - nw.py)) * (nw.lat - se.lat),
      nw.lon + ((x - nw.px) / (se.px - nw.px)) * (se.lon - nw.lon),
    ];
  }

  protected cartaAPantalla(x: number, y: number): [number, number] {
    return [(x - this.centroX) * this.escala + this.ancho / 2, (y - this.centroY) * this.escala + this.alto / 2];
  }

  protected pantallaACarta(x: number, y: number): [number, number] {
    return [(x - this.ancho / 2) / this.escala + this.centroX, (y - this.alto / 2) / this.escala + this.centroY];
  }

  protected latLonAPantalla(lat: number, lon: number): [number, number] {
    return this.cartaAPantalla(...this.latLonACarta(lat, lon));
  }

  // Píxeles de pantalla por milla náutica en una latitud dada.
  protected pxPorMilla(lat: number, lon: number): number {
    const [, y1] = this.latLonAPantalla(lat, lon);
    const [, y2] = this.latLonAPantalla(lat - 1 / 60, lon);
    return Math.abs(y2 - y1);
  }

  // Punto a una distancia (millas) y rumbo desde un lat/lon.
  static desplazar(lat: number, lon: number, rumboDeg: number, distNm: number): [number, number] {
    const r = (rumboDeg * Math.PI) / 180;
    return [lat + (Math.cos(r) * distNm) / 60, lon + (Math.sin(r) * distNm) / (60 * Math.cos((lat * Math.PI) / 180))];
  }

  static rangoYMarcacion(lat1: number, lon1: number, lat2: number, lon2: number): { nm: number; deg: number } {
    const yN = (lat2 - lat1) * 60;
    const xE = (lon2 - lon1) * 60 * Math.cos((lat1 * Math.PI) / 180);
    return { nm: Math.hypot(xE, yN), deg: (((Math.atan2(xE, yN) * 180) / Math.PI) + 360) % 360 };
  }

  // ----- Mouse ------------------------------------------------------------------
  private cablearMouse(): void {
    let arrastre: { x: number; y: number; cx: number; cy: number } | null = null;
    const local = (e: MouseEvent): [number, number] => {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    this.canvas.addEventListener('mousedown', (e) => {
      const [x, y] = local(e);
      if (this.alPresionar(x, y)) return;
      if (this.herramienta === 'medir') {
        const p = this.pantallaACarta(x, y);
        this.medicion = { a: p, b: p };
      } else {
        arrastre = { x, y, cx: this.centroX, cy: this.centroY };
      }
    });
    window.addEventListener('mouseup', () => {
      if (arrastre) arrastre = null;
      this.alSoltar();
    });
    this.canvas.addEventListener('mousemove', (e) => {
      const [x, y] = local(e);
      this.mouseCarta = this.pantallaACarta(x, y);
      const apretado = e.buttons === 1;
      if (apretado && this.herramienta === 'medir' && this.medicion) {
        this.medicion.b = this.mouseCarta;
      } else if (apretado && arrastre) {
        this.alArrastrarCarta(x - arrastre.x, y - arrastre.y, arrastre);
      }
      this.alMover(x, y, apretado);
      const [lat, lon] = this.cartaALatLon(...this.mouseCarta);
      this.alMoverMouse({ lat, lon });
      this.dibujar();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouseCarta = null;
      this.alMoverMouse(null);
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.5 : 1 / 1.5, local(e));
    }, { passive: false });
    this.canvas.addEventListener('dblclick', (e) => this.alDobleClick(...local(e)));
  }

  // ----- Dibujo -----------------------------------------------------------------
  dibujar(): void {
    if (this.ancho <= 0) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.ancho, this.alto);
    ctx.save();
    ctx.translate(this.ancho / 2, this.alto / 2);
    ctx.scale(this.escala, this.escala);
    ctx.translate(-this.centroX, -this.centroY);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.imagen, 0, 0);
    ctx.restore();
    this.dibujarEncima(ctx);
    if (this.medicion) this.dibujarMedicion();
  }

  protected abstract dibujarEncima(ctx: CanvasRenderingContext2D): void;

  // Casco de buque (proa aguzada, popa recta) con un punto en el centro, como
  // los íconos del Melipal. Toma el tamaño real (eslora) si con el zoom es
  // mayor que el mínimo visible.
  protected dibujarCasco(
    lat: number, lon: number, headingDeg: number, esloraM: number,
    colores: { relleno: string; borde: string; centro: string },
  ): void {
    const ctx = this.ctx;
    const [x, y] = this.latLonAPantalla(lat, lon);
    const largo = Math.max(26, (esloraM / 1852) * this.pxPorMilla(lat, lon));
    const ancho = largo * 0.28;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((headingDeg * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -largo / 2);
    ctx.bezierCurveTo(ancho / 2, -largo / 4, ancho / 2, largo / 4, ancho / 2.4, largo / 2);
    ctx.lineTo(-ancho / 2.4, largo / 2);
    ctx.bezierCurveTo(-ancho / 2, largo / 4, -ancho / 2, -largo / 4, 0, -largo / 2);
    ctx.fillStyle = colores.relleno;
    ctx.fill();
    ctx.strokeStyle = colores.borde;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = colores.centro;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2.5, ancho / 4), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Vector de rumbo: largo = distancia que recorre en `minutos` a su velocidad.
  protected dibujarVectorRumbo(
    lat: number, lon: number, headingDeg: number, velocidadKn: number, minutos: number, color: string,
  ): void {
    const distNm = (Math.abs(velocidadKn) * minutos) / 60;
    if (distNm < 1e-4) return;
    const rumbo = velocidadKn >= 0 ? headingDeg : headingDeg + 180;
    const [x1, y1] = this.latLonAPantalla(lat, lon);
    const [x2, y2] = this.latLonAPantalla(...VistaCarta.desplazar(lat, lon, rumbo, distNm));
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Anillos de distancia alrededor de un punto (hasta 12).
  protected dibujarAnillos(lat: number, lon: number, pasoNm: number, color: string): void {
    const ctx = this.ctx;
    const [x, y] = this.latLonAPantalla(lat, lon);
    const pxPorMilla = this.pxPorMilla(lat, lon);
    const alcance = Math.hypot(this.ancho, this.alto);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.fillStyle = color;
    ctx.font = '11px Tahoma, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    for (let i = 1; i * pasoNm * pxPorMilla < alcance && i <= 12; i++) {
      const r = i * pasoNm * pxPorMilla;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${+(i * pasoNm).toFixed(3)}nm`, x + 3, y - r);
    }
  }

  // Recorrido: línea con puntos cada `intervaloSeg`, terminando en `hasta`.
  protected dibujarRecorrido(
    puntos: readonly { t: number; lat: number; lon: number }[],
    intervaloSeg: number,
    hasta: { lat: number; lon: number } | null,
    color: string,
  ): void {
    const ctx = this.ctx;
    const pts: [number, number][] = [];
    let ultimoT = -Infinity;
    for (const p of puntos) {
      if (p.t - ultimoT < intervaloSeg * 1000) continue;
      ultimoT = p.t;
      pts.push(this.latLonAPantalla(p.lat, p.lon));
    }
    if (pts.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (hasta) ctx.lineTo(...this.latLonAPantalla(hasta.lat, hasta.lon));
    ctx.stroke();
    // Puntos de muestreo: solo los que quedan separados en pantalla; con la
    // carta alejada se pegan unos con otros y engrosan la línea.
    ctx.fillStyle = color;
    let ultimo: [number, number] | null = null;
    for (const [x, y] of pts) {
      if (ultimo && Math.hypot(x - ultimo[0], y - ultimo[1]) < 8) continue;
      ctx.fillRect(x - 2, y - 2, 4, 4);
      ultimo = [x, y];
    }
  }

  private dibujarMedicion(): void {
    const m = this.medicion!;
    const ctx = this.ctx;
    const [x1, y1] = this.cartaAPantalla(...m.a);
    const [x2, y2] = this.cartaAPantalla(...m.b);
    const [lat1, lon1] = this.cartaALatLon(...m.a);
    const [lat2, lon2] = this.cartaALatLon(...m.b);
    const rb = VistaCarta.rangoYMarcacion(lat1, lon1, lat2, lon2);
    ctx.strokeStyle = COLOR_MEDICION;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    const texto = `${rb.nm.toFixed(3)} nm  ${rb.deg.toFixed(1)}°`;
    ctx.font = '12px Tahoma, sans-serif';
    const w = ctx.measureText(texto).width + 8;
    ctx.fillStyle = '#ffffe1';
    ctx.fillRect(x2 + 8, y2 - 20, w, 18);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(x2 + 8, y2 - 20, w, 18);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(texto, x2 + 12, y2 - 11);
  }
}
