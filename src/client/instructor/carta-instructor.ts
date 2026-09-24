// Carta del instructor, con el aspecto del "Melipal Instructor Module" (ver
// docs/referencia/melipal-instructor.png): todos los buques de la sesión en
// rojo con su etiqueta amarilla "OS-01", sus vectores y recorridos, y la
// posibilidad de ubicar cada buque antes de abrir la sesión (click para la
// posición, arrastrar para el rumbo).

import type { CartaParseada, EstadoBuqueDTO, Participacion, PuntoTraza } from '../../shared/types.js';
import { VistaCarta, type InfoMouse } from '../carta/vista-carta.js';

const ESLORA_M = 92;
const COLOR_BUQUE = { relleno: '#e00000', borde: '#600000', centro: '#ffff00' };
const COLOR_VECTOR = '#e00000';
const COLOR_TRAZA = '#800080';
const COLOR_SEGMENTOS = 'rgba(255, 80, 80, 0.7)';

interface Ubicando {
  ownshipIndex: number;
  lat: number | null;
  lon: number | null;
  headingDeg: number;
  arrastrando: boolean;
}

export class CartaInstructor extends VistaCarta {
  vectorMin = 6;
  anillosNm: number | null = null;
  mostrarTrazas = true;
  mostrarSegmentos = false;
  mostrarBuques = true;
  // Buque de referencia: el cursor mide marcación y distancia desde él.
  seleccionado: number | null = null;

  private buques: EstadoBuqueDTO[] = [];
  private trazas = new Map<number, PuntoTraza[]>();
  private iniciales: Participacion[] = [];
  private ubicando: Ubicando | null = null;

  onSeleccion: (ownshipIndex: number | null) => void = () => {};
  onMouse: (info: (InfoMouse & { rangoNm: number | null; marcacion: number | null }) | null) => void = () => {};
  onUbicado: (ownshipIndex: number, lat: number, lon: number, headingDeg: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement, carta: CartaParseada, imagen: HTMLImageElement) {
    super(canvas, carta, imagen);
    this.resize(true);
  }

  // ----- Datos -----------------------------------------------------------------
  setBuques(buques: EstadoBuqueDTO[]): void {
    this.buques = buques;
    this.dibujar();
  }

  setIniciales(parts: Participacion[]): void {
    this.iniciales = parts;
    this.dibujar();
  }

  setTrazas(porBuque: Record<number, PuntoTraza[]>): void {
    this.trazas = new Map(Object.entries(porBuque).map(([k, v]) => [Number(k), v]));
    this.dibujar();
  }

  agregarPunto(ownshipIndex: number, p: PuntoTraza): void {
    const lista = this.trazas.get(ownshipIndex) ?? [];
    lista.push(p);
    this.trazas.set(ownshipIndex, lista);
  }

  seleccionar(ownshipIndex: number | null): void {
    this.seleccionado = ownshipIndex;
    this.dibujar();
    this.onSeleccion(ownshipIndex);
  }

  // Encuadra un buque en el centro de la carta.
  centrarBuque(ownshipIndex: number): void {
    const b = this.buques.find((x) => x.ownshipIndex === ownshipIndex);
    const p = this.iniciales.find((x) => x.ownshipIndex === ownshipIndex);
    if (b) this.centrarEn(b.lat, b.lon);
    else if (p?.latInicial != null && p.lonInicial != null) this.centrarEn(p.latInicial, p.lonInicial);
  }

  ajustarACarta(): void {
    this.centroX = this.imagen.naturalWidth / 2;
    this.centroY = this.imagen.naturalHeight / 2;
    this.resize(true);
  }

  // ----- Ubicar buque (antes de abrir) ---------------------------------------------
  iniciarUbicar(ownshipIndex: number): void {
    this.ubicando = { ownshipIndex, lat: null, lon: null, headingDeg: 0, arrastrando: false };
    this.canvas.classList.add('ubicando');
  }

  cancelarUbicar(): void {
    this.ubicando = null;
    this.canvas.classList.remove('ubicando');
    this.dibujar();
  }

  estaUbicando(): boolean {
    return this.ubicando !== null;
  }

  protected override alPresionar(x: number, y: number): boolean {
    if (this.ubicando) {
      const [lat, lon] = this.cartaALatLon(...this.pantallaACarta(x, y));
      Object.assign(this.ubicando, { lat, lon, headingDeg: 0, arrastrando: true });
      return true;
    }
    if (this.herramienta !== 'puntero') return false;
    // Click sobre un buque: pasa a ser la referencia.
    for (const b of this.posicionesVisibles()) {
      const [bx, by] = this.latLonAPantalla(b.lat, b.lon);
      if (Math.hypot(bx - x, by - y) < 14) {
        this.seleccionar(b.ownshipIndex === this.seleccionado ? null : b.ownshipIndex);
        return true;
      }
    }
    return false;
  }

  protected override alMover(x: number, y: number, apretado: boolean): void {
    const u = this.ubicando;
    if (!u || !u.arrastrando || u.lat === null || u.lon === null || !apretado) return;
    // Rumbo desde el punto fijado hacia el cursor (0 = norte, horario).
    const [lat, lon] = this.cartaALatLon(...this.pantallaACarta(x, y));
    u.headingDeg = VistaCarta.rangoYMarcacion(u.lat, u.lon, lat, lon).deg;
  }

  protected override alSoltar(): void {
    const u = this.ubicando;
    if (!u || !u.arrastrando || u.lat === null || u.lon === null) return;
    const { ownshipIndex, lat, lon, headingDeg } = u;
    this.cancelarUbicar();
    this.onUbicado(ownshipIndex, lat, lon, headingDeg);
  }

  protected override alMoverMouse(info: InfoMouse | null): void {
    if (!info) {
      this.onMouse(null);
      return;
    }
    const ref = this.posicionesVisibles().find((b) => b.ownshipIndex === this.seleccionado);
    const rb = ref ? VistaCarta.rangoYMarcacion(ref.lat, ref.lon, info.lat, info.lon) : null;
    this.onMouse({ ...info, rangoNm: rb?.nm ?? null, marcacion: rb?.deg ?? null });
  }

  // Posiciones que se ven: las vivas si la sesión está corriendo, si no las
  // iniciales que fijó el profesor.
  private posicionesVisibles(): { ownshipIndex: number; lat: number; lon: number; headingDeg: number }[] {
    if (this.buques.length > 0) return this.buques;
    return this.iniciales
      .filter((p) => p.latInicial !== null && p.lonInicial !== null)
      .map((p) => ({ ownshipIndex: p.ownshipIndex, lat: p.latInicial!, lon: p.lonInicial!, headingDeg: p.headingInicial ?? 0 }));
  }

  // ----- Dibujo -----------------------------------------------------------------
  protected override dibujarEncima(): void {
    if (this.mostrarSegmentos) this.dibujarSegmentos();
    const ref = this.posicionesVisibles().find((b) => b.ownshipIndex === this.seleccionado);
    if (ref && this.anillosNm) this.dibujarAnillos(ref.lat, ref.lon, this.anillosNm, COLOR_TRAZA);

    if (this.buques.length > 0) {
      if (this.mostrarTrazas) {
        for (const b of this.buques) this.dibujarRecorrido(this.trazas.get(b.ownshipIndex) ?? [], 30, b, COLOR_TRAZA);
      }
      if (this.mostrarBuques) {
        for (const b of this.buques) {
          this.dibujarVectorRumbo(b.lat, b.lon, b.headingDeg, b.velocidadKn, this.vectorMin, COLOR_VECTOR);
          this.dibujarCasco(b.lat, b.lon, b.headingDeg, ESLORA_M, COLOR_BUQUE);
          this.dibujarEtiqueta(b.ownshipIndex, b.lat, b.lon, false);
        }
      }
    } else {
      // Antes de abrir: posiciones iniciales en trazo punteado ("todavía no
      // están vivos").
      for (const p of this.posicionesVisibles()) {
        if (this.ubicando?.ownshipIndex === p.ownshipIndex && this.ubicando.lat !== null) continue;
        this.dibujarCasco(p.lat, p.lon, p.headingDeg, ESLORA_M, { relleno: 'rgba(224,0,0,0.35)', borde: '#e00000', centro: '#ffff00' });
        this.dibujarEtiqueta(p.ownshipIndex, p.lat, p.lon, true);
      }
    }

    const u = this.ubicando;
    if (u && u.lat !== null && u.lon !== null) {
      this.dibujarCasco(u.lat, u.lon, u.headingDeg, ESLORA_M, { relleno: '#ffc800', borde: '#000', centro: '#e00000' });
      const [x, y] = this.latLonAPantalla(u.lat, u.lon);
      const a = ((u.headingDeg - 90) * Math.PI) / 180;
      this.ctx.strokeStyle = '#ffc800';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      this.ctx.lineTo(x + Math.cos(a) * 80, y + Math.sin(a) * 80);
      this.ctx.stroke();
      this.dibujarEtiqueta(u.ownshipIndex, u.lat, u.lon, false, `${u.headingDeg.toFixed(0)}°`);
    }
  }

  // Etiqueta amarilla "OS-01" arriba a la derecha del buque, como en el original.
  private dibujarEtiqueta(os: number, lat: number, lon: number, inicial: boolean, extra?: string): void {
    const ctx = this.ctx;
    const [x, y] = this.latLonAPantalla(lat, lon);
    const texto = `OS-${String(os).padStart(2, '0')}${extra ? ` ${extra}` : ''}`;
    ctx.font = 'bold 11px Tahoma, Verdana, sans-serif';
    const w = ctx.measureText(texto).width + 6;
    const bx = x + 8;
    const by = y - 24;
    ctx.fillStyle = inicial ? 'rgba(255,255,0,0.6)' : '#ffff00';
    ctx.fillRect(bx, by, w, 14);
    if (os === this.seleccionado) {
      ctx.strokeStyle = '#0000ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx - 1, by - 1, w + 2, 16);
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(texto, bx + 3, by + 7);
  }

  // Segmentos de costa que usa el radar para generar ecos (ayuda al profesor
  // a entender qué va a ver el alumno en el PPI).
  private dibujarSegmentos(): void {
    const ctx = this.ctx;
    const { esquinaNW: nw, esquinaSE: se, anchoMillas, altoMillas } = this.carta;
    const xMilla = (se.px - nw.px) / anchoMillas;
    const yMilla = (se.py - nw.py) / altoMillas;
    ctx.strokeStyle = COLOR_SEGMENTOS;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const s of this.carta.segmentos) {
      ctx.moveTo(...this.cartaAPantalla(nw.px + s.xMillas1 * xMilla, se.py - s.yMillas1 * yMilla));
      ctx.lineTo(...this.cartaAPantalla(nw.px + s.xMillas2 * xMilla, se.py - s.yMillas2 * yMilla));
    }
    ctx.stroke();
  }
}
