// Visor de cartas del aula, réplica del "Easy Navigator" del Melipal (ver
// docs/referencia/melipal-navigator.png y el manual, sección 4.3).
//
// Como un plotter conectado al GPS, muestra solo el buque propio: su posición,
// un vector de rumbo cuyo largo se fija en minutos, y el recorrido realizado
// ("trace"). El recorrido lo guarda el server (un punto cada 5 s) para que no
// se pierda al recargar; acá se elige cada cuánto dibujar un punto, se puede
// ocultar, pausar o borrar, y se agregan marcas con nombre y descripción.

import type { CartaParseada, EstadoBuqueDTO, PuntoTraza } from '../../shared/types.js';
import { VistaCarta, type InfoMouse } from '../carta/vista-carta.js';

export type ModoNavegador = 'chart' | 'true' | 'relative';

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
const ESLORA_M = 92;

export class Navegador extends VistaCarta {
  modo: ModoNavegador = 'relative';
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

  onMouse: (info: { lat: number; lon: number; rangoNm: number | null; marcacion: number | null } | null) => void = () => {};
  onAbrirMarca: (m: MarcaTraza) => void = () => {};

  constructor(canvas: HTMLCanvasElement, carta: CartaParseada, imagen: HTMLImageElement, private claveAlmacen: string) {
    super(canvas, carta, imagen);
    this.cargarAlmacen();
    this.resize(true);
  }

  // ----- Modos de presentación ---------------------------------------------------
  setModo(modo: ModoNavegador): void {
    this.modo = modo;
    this.seguirBuque(true);
    this.dibujar();
    this.onCambio();
  }

  protected override zoomAlCursor(): boolean {
    return this.modo === 'chart';
  }

  protected override despuesDeZoom(): void {
    this.seguirBuque(true);
  }

  // Arrastrar la carta pasa a modo carta (en los modos de navegación la
  // carta la mueve el buque).
  protected override alArrastrarCarta(dx: number, dy: number, inicio: { cx: number; cy: number }): void {
    if (this.modo !== 'chart' && Math.hypot(dx, dy) > 4) this.setModo('chart');
    if (this.modo === 'chart') super.alArrastrarCarta(dx, dy, inicio);
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

  // ----- Mouse ------------------------------------------------------------------
  protected override alMoverMouse(info: InfoMouse | null): void {
    if (!info) {
      this.onMouse(null);
      return;
    }
    let rangoNm: number | null = null;
    let marcacion: number | null = null;
    if (this.buque) {
      const rb = VistaCarta.rangoYMarcacion(this.buque.lat, this.buque.lon, info.lat, info.lon);
      rangoNm = rb.nm;
      marcacion = rb.deg;
    }
    this.onMouse({ ...info, rangoNm, marcacion });
  }

  // Doble click sobre una marca: ver / editar su descripción.
  protected override alDobleClick(x: number, y: number): void {
    for (const m of this.marcas) {
      const [mx, my] = this.latLonAPantalla(m.lat, m.lon);
      if (Math.hypot(mx - x, my - y) < 10) {
        this.onAbrirMarca(m);
        return;
      }
    }
  }

  // ----- Dibujo -----------------------------------------------------------------
  protected override dibujarEncima(): void {
    if (this.mostrarTraza) this.dibujarRecorrido(this.traza, this.intervaloSeg, this.buque, COLOR_TRAZA);
    this.dibujarMarcas();
    const b = this.buque;
    if (!b) return;
    if (this.anillosNm) this.dibujarAnillos(b.lat, b.lon, this.anillosNm, COLOR_HERRAMIENTAS);
    this.dibujarVectorRumbo(b.lat, b.lon, b.headingDeg, b.velocidadKn, this.vectorMin, COLOR_VECTOR);
    this.dibujarCasco(b.lat, b.lon, b.headingDeg, ESLORA_M, { relleno: '#ffff00', borde: '#000000', centro: '#ff0000' });
  }

  private dibujarMarcas(): void {
    const ctx = this.ctx;
    ctx.font = '13px "Times New Roman", serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    for (const m of this.marcas) {
      const [x, y] = this.latLonAPantalla(m.lat, m.lon);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = COLOR_TRAZA;
      ctx.lineWidth = 1;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.strokeRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = '#20207a';
      ctx.fillText(m.nombre ? `${m.n} ${m.nombre}` : String(m.n), x + 4, y - 3);
    }
  }
}
