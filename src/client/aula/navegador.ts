// Visor de cartas del aula, réplica del "Easy Navigator" del Melipal (ver
// docs/referencia/melipal-navigator.png y el manual, sección 4.3).
//
// Como un plotter conectado al GPS, muestra solo el buque propio: su posición,
// un vector de rumbo cuyo largo se fija en minutos, y el recorrido realizado
// ("trace"). El recorrido lo guarda el server (un punto cada 5 s) para que no
// se pierda al recargar; acá se elige cada cuánto dibujar un punto, se puede
// ocultar, pausar o borrar, y se agregan marcas con nombre y descripción.

import type { CartaParseada, EstadoBuqueDTO, PuntoTraza } from '../../shared/types.js';

export type ModoNavegador = 'chart' | 'true' | 'relative';
type Herramienta = 'puntero' | 'medir';

export interface MarcaTraza {
  n: number;
  t: number;
  lat: number;
  lon: number;
  nombre: string;
  descripcion: string;
}

// Colores por defecto del Easy Navigator (clPurple para traza, vector y
// herramientas; buque amarillo con centro rojo).
const COLOR_TRAZA = '#800080';
const COLOR_VECTOR = '#800080';
const COLOR_HERRAMIENTAS = '#800080';
const ZOOM_PASO = 1.5;

export class Navegador {
  private ctx: CanvasRenderingContext2D;
  private ancho = 0;
  private alto = 0;
  private dpr = 1;
  // Vista: punto de la carta (px de la imagen) que queda en el centro del
  // canvas, y escala (px de pantalla por px de la imagen).
  private centroX: number;
  private centroY: number;
  private escala = 1;
  private escalaMin = 0.1;

  modo: ModoNavegador = 'relative';
  herramienta: Herramienta = 'puntero';
  mostrarTraza = true;
  muestrear = true;
  intervaloSeg = 30;
  vectorMin = 10;
  anillosNm: number | null = null;

  private buque: EstadoBuqueDTO | null = null;
  private traza: PuntoTraza[] = [];
  private marcas: MarcaTraza[] = [];
  // Rango a partir del cual se muestra el recorrido (después de "borrar") y
  // tramos en que el alumno pausó el muestreo. Se guardan en el navegador.
  private borradoDesde = 0;
  private pausas: { desde: number; hasta: number | null }[] = [];
  private medicion: { a: [number, number]; b: [number, number] } | null = null;
  private mouseCarta: [number, number] | null = null;

  onCambio: () => void = () => {};
  onMouse: (info: { lat: number; lon: number; rangoNm: number | null; marcacion: number | null } | null) => void = () => {};
  onAbrirMarca: (m: MarcaTraza) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement,
    private carta: CartaParseada,
    private imagen: HTMLImageElement,
    private claveAlmacen: string,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.centroX = imagen.naturalWidth / 2;
    this.centroY = imagen.naturalHeight / 2;
    this.cargarAlmacen();
    this.cablearMouse();
    this.resize(true);
    // El panel cambia de tamaño al elegir otra vista principal en el aula.
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
    if (focoPantalla && this.modo === 'chart') {
      // Zoom hacia el cursor: el punto bajo el mouse queda fijo.
      const [fx, fy] = this.pantallaACarta(...focoPantalla);
      this.centroX = fx - (focoPantalla[0] - this.ancho / 2) / nueva;
      this.centroY = fy - (focoPantalla[1] - this.alto / 2) / nueva;
    }
    this.escala = nueva;
    this.seguirBuque(true);
    this.dibujar();
    this.onCambio();
  }

  setModo(modo: ModoNavegador): void {
    this.modo = modo;
    this.seguirBuque(true);
    this.dibujar();
    this.onCambio();
  }

  // En Relative Motion el buque queda siempre al centro. En True Motion la
  // carta queda quieta y se recentra cuando el buque se acerca al borde.
  private seguirBuque(forzar = false): void {
    if (!this.buque || this.modo === 'chart') return;
    const [bx, by] = this.latLonACarta(this.buque.lat, this.buque.lon);
    if (this.modo === 'relative') {
      this.centroX = bx;
      this.centroY = by;
      return;
    }
    const [sx, sy] = this.cartaAPantalla(bx, by);
    const margenX = this.ancho * 0.15;
    const margenY = this.alto * 0.15;
    if (forzar || sx < margenX || sx > this.ancho - margenX || sy < margenY || sy > this.alto - margenY) {
      this.centroX = bx;
      this.centroY = by;
    }
  }

  // ----- Datos -----------------------------------------------------------------
  actualizarBuque(b: EstadoBuqueDTO): void {
    this.buque = b;
    this.seguirBuque();
    this.dibujar();
  }

  setTraza(puntos: PuntoTraza[]): void {
    this.traza = puntos.filter((p) => !this.enPausa(p.t));
    this.dibujar();
  }

  agregarPunto(p: PuntoTraza): void {
    if (this.enPausa(p.t)) return;
    this.traza.push(p);
  }

  setMuestrear(si: boolean): void {
    this.muestrear = si;
    const ahora = Date.now();
    if (!si) this.pausas.push({ desde: ahora, hasta: null });
    else {
      const abierta = this.pausas.find((p) => p.hasta === null);
      if (abierta) abierta.hasta = ahora;
    }
    this.guardarAlmacen();
  }

  borrarTraza(): void {
    this.borradoDesde = Date.now();
    this.traza = [];
    this.guardarAlmacen();
    this.dibujar();
  }

  listarMarcas(): readonly MarcaTraza[] {
    return this.marcas;
  }

  // Marca en la posición actual del buque (como el botón "Mark" del original).
  nuevaMarca(): MarcaTraza | null {
    if (!this.buque) return null;
    const n = this.marcas.reduce((max, m) => Math.max(max, m.n), -1) + 1;
    return { n, t: Date.now(), lat: this.buque.lat, lon: this.buque.lon, nombre: '', descripcion: '' };
  }

  guardarMarca(m: MarcaTraza): void {
    const i = this.marcas.findIndex((x) => x.n === m.n);
    if (i >= 0) this.marcas[i] = m;
    else this.marcas.push(m);
    this.guardarAlmacen();
    this.dibujar();
  }

  borrarMarca(n: number): void {
    this.marcas = this.marcas.filter((m) => m.n !== n);
    this.guardarAlmacen();
    this.dibujar();
  }

  private enPausa(t: number): boolean {
    if (t < this.borradoDesde) return true;
    return this.pausas.some((p) => t >= p.desde && (p.hasta === null || t <= p.hasta));
  }

  private cargarAlmacen(): void {
    try {
      const raw = localStorage.getItem(this.claveAlmacen);
      if (!raw) return;
      const d = JSON.parse(raw) as { borradoDesde?: number; pausas?: Navegador['pausas']; marcas?: MarcaTraza[] };
      this.borradoDesde = d.borradoDesde ?? 0;
      this.pausas = d.pausas ?? [];
      this.marcas = d.marcas ?? [];
      this.muestrear = !this.pausas.some((p) => p.hasta === null);
    } catch {
      // Sin almacenamiento (modo privado, etc.): se trabaja solo en memoria.
    }
  }

  private guardarAlmacen(): void {
    try {
      localStorage.setItem(this.claveAlmacen, JSON.stringify({
        borradoDesde: this.borradoDesde, pausas: this.pausas, marcas: this.marcas,
      }));
    } catch {
      // idem
    }
  }

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

  private cartaAPantalla(x: number, y: number): [number, number] {
    return [(x - this.centroX) * this.escala + this.ancho / 2, (y - this.centroY) * this.escala + this.alto / 2];
  }

  private pantallaACarta(x: number, y: number): [number, number] {
    return [(x - this.ancho / 2) / this.escala + this.centroX, (y - this.alto / 2) / this.escala + this.centroY];
  }

  // Punto a una distancia (millas) y marcación desde un lat/lon.
  private desplazar(lat: number, lon: number, rumboDeg: number, distNm: number): [number, number] {
    const r = (rumboDeg * Math.PI) / 180;
    const dLat = (Math.cos(r) * distNm) / 60;
    const dLon = (Math.sin(r) * distNm) / (60 * Math.cos((lat * Math.PI) / 180));
    return [lat + dLat, lon + dLon];
  }

  private rangoYMarcacion(lat1: number, lon1: number, lat2: number, lon2: number): { nm: number; deg: number } {
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
      if (this.herramienta === 'medir') {
        const p = this.pantallaACarta(x, y);
        this.medicion = { a: p, b: p };
      } else {
        arrastre = { x, y, cx: this.centroX, cy: this.centroY };
      }
    });
    window.addEventListener('mouseup', () => { arrastre = null; });
    this.canvas.addEventListener('mousemove', (e) => {
      const [x, y] = local(e);
      this.mouseCarta = this.pantallaACarta(x, y);
      if (e.buttons === 1 && this.herramienta === 'medir' && this.medicion) {
        this.medicion.b = this.mouseCarta;
      } else if (arrastre && e.buttons === 1) {
        // Arrastrar la carta pasa a modo carta (en los modos de navegación la
        // carta la mueve el buque).
        if (this.modo !== 'chart' && Math.hypot(x - arrastre.x, y - arrastre.y) > 4) this.setModo('chart');
        if (this.modo === 'chart') {
          this.centroX = arrastre.cx - (x - arrastre.x) / this.escala;
          this.centroY = arrastre.cy - (y - arrastre.y) / this.escala;
        }
      }
      this.informarMouse();
      this.dibujar();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouseCarta = null;
      this.onMouse(null);
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? ZOOM_PASO : 1 / ZOOM_PASO, local(e));
    }, { passive: false });
    this.canvas.addEventListener('dblclick', (e) => {
      // Doble click sobre una marca: ver / editar su descripción.
      const [x, y] = local(e);
      for (const m of this.marcas) {
        const [mx, my] = this.cartaAPantalla(...this.latLonACarta(m.lat, m.lon));
        if (Math.hypot(mx - x, my - y) < 10) {
          this.onAbrirMarca(m);
          return;
        }
      }
    });
  }

  private informarMouse(): void {
    if (!this.mouseCarta) return;
    const [lat, lon] = this.cartaALatLon(...this.mouseCarta);
    let rangoNm: number | null = null;
    let marcacion: number | null = null;
    if (this.buque) {
      const rb = this.rangoYMarcacion(this.buque.lat, this.buque.lon, lat, lon);
      rangoNm = rb.nm;
      marcacion = rb.deg;
    }
    this.onMouse({ lat, lon, rangoNm, marcacion });
  }

  // ----- Dibujo -----------------------------------------------------------------
  dibujar(): void {
    if (this.ancho <= 0) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.ancho, this.alto);

    // Carta
    ctx.save();
    ctx.translate(this.ancho / 2, this.alto / 2);
    ctx.scale(this.escala, this.escala);
    ctx.translate(-this.centroX, -this.centroY);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.imagen, 0, 0);
    ctx.restore();

    if (this.mostrarTraza) this.dibujarTraza();
    this.dibujarMarcas();
    if (this.buque) {
      if (this.anillosNm) this.dibujarAnillos(this.buque, this.anillosNm);
      this.dibujarVector(this.buque);
      this.dibujarBuque(this.buque);
    }
    if (this.medicion) this.dibujarMedicion();
  }

  private dibujarTraza(): void {
    const ctx = this.ctx;
    // Submuestreo al intervalo elegido; el último punto es la posición actual.
    const pts: [number, number][] = [];
    let ultimoT = -Infinity;
    for (const p of this.traza) {
      if (p.t - ultimoT < this.intervaloSeg * 1000) continue;
      ultimoT = p.t;
      pts.push(this.cartaAPantalla(...this.latLonACarta(p.lat, p.lon)));
    }
    if (pts.length === 0) return;
    ctx.strokeStyle = COLOR_TRAZA;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (this.buque) ctx.lineTo(...this.cartaAPantalla(...this.latLonACarta(this.buque.lat, this.buque.lon)));
    ctx.stroke();
    // Puntos de muestreo: solo los que quedan separados en pantalla; con la
    // carta alejada se pegan unos con otros y engrosan la línea.
    ctx.fillStyle = COLOR_TRAZA;
    let ultimo: [number, number] | null = null;
    for (const [x, y] of pts) {
      if (ultimo && Math.hypot(x - ultimo[0], y - ultimo[1]) < 8) continue;
      ctx.fillRect(x - 2, y - 2, 4, 4);
      ultimo = [x, y];
    }
  }

  private dibujarMarcas(): void {
    const ctx = this.ctx;
    ctx.font = '13px "Times New Roman", serif';
    ctx.textBaseline = 'bottom';
    for (const m of this.marcas) {
      const [x, y] = this.cartaAPantalla(...this.latLonACarta(m.lat, m.lon));
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = COLOR_TRAZA;
      ctx.lineWidth = 1;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.strokeRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = '#20207a';
      ctx.fillText(m.nombre ? `${m.n} ${m.nombre}` : String(m.n), x + 4, y - 3);
    }
  }

  private dibujarVector(b: EstadoBuqueDTO): void {
    const distNm = (Math.abs(b.velocidadKn) * this.vectorMin) / 60;
    if (distNm < 1e-4) return;
    const rumbo = b.velocidadKn >= 0 ? b.headingDeg : b.headingDeg + 180;
    const [lat2, lon2] = this.desplazar(b.lat, b.lon, rumbo, distNm);
    const [x1, y1] = this.cartaAPantalla(...this.latLonACarta(b.lat, b.lon));
    const [x2, y2] = this.cartaAPantalla(...this.latLonACarta(lat2, lon2));
    const ctx = this.ctx;
    ctx.strokeStyle = COLOR_VECTOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Buque amarillo con borde negro y centro rojo, como el ícono del original.
  // Tamaño real (eslora) si con el zoom queda más grande que el mínimo.
  private dibujarBuque(b: EstadoBuqueDTO): void {
    const ctx = this.ctx;
    const [x, y] = this.cartaAPantalla(...this.latLonACarta(b.lat, b.lon));
    const [, yMilla] = this.cartaAPantalla(...this.latLonACarta(b.lat - 1 / 60, b.lon));
    const pxPorMilla = Math.abs(yMilla - y);
    const esloraNm = 92 / 1852;
    const largo = Math.max(26, esloraNm * pxPorMilla);
    const ancho = largo * 0.28;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((b.headingDeg * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -largo / 2);
    ctx.bezierCurveTo(ancho / 2, -largo / 4, ancho / 2, largo / 4, ancho / 2.4, largo / 2);
    ctx.lineTo(-ancho / 2.4, largo / 2);
    ctx.bezierCurveTo(-ancho / 2, largo / 4, -ancho / 2, -largo / 4, 0, -largo / 2);
    ctx.fillStyle = '#ffff00';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2.5, ancho / 4), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private dibujarAnillos(b: EstadoBuqueDTO, pasoNm: number): void {
    const ctx = this.ctx;
    const [x, y] = this.cartaAPantalla(...this.latLonACarta(b.lat, b.lon));
    const [, yMilla] = this.cartaAPantalla(...this.latLonACarta(b.lat - 1 / 60, b.lon));
    const pxPorMilla = Math.abs(yMilla - y);
    const alcance = Math.hypot(this.ancho, this.alto);
    ctx.strokeStyle = COLOR_HERRAMIENTAS;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLOR_HERRAMIENTAS;
    ctx.font = '11px Tahoma, sans-serif';
    ctx.textBaseline = 'bottom';
    for (let i = 1; i * pasoNm * pxPorMilla < alcance && i <= 12; i++) {
      const r = i * pasoNm * pxPorMilla;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${+(i * pasoNm).toFixed(3)}nm`, x + 3, y - r);
    }
  }

  private dibujarMedicion(): void {
    const m = this.medicion!;
    const ctx = this.ctx;
    const [x1, y1] = this.cartaAPantalla(...m.a);
    const [x2, y2] = this.cartaAPantalla(...m.b);
    const [lat1, lon1] = this.cartaALatLon(...m.a);
    const [lat2, lon2] = this.cartaALatLon(...m.b);
    const rb = this.rangoYMarcacion(lat1, lon1, lat2, lon2);
    ctx.strokeStyle = COLOR_HERRAMIENTAS;
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
    ctx.fillText(texto, x2 + 12, y2 - 11);
  }

  limpiarMedicion(): void {
    this.medicion = null;
    this.dibujar();
  }
}
