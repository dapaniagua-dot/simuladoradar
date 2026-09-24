// Carta del instructor, con el aspecto del "Melipal Instructor Module" (ver
// docs/referencia/melipal-instructor.png): todos los buques de la sesión en
// rojo con su etiqueta amarilla "OS-01", sus vectores y recorridos, y los
// blancos del instructor (Directed Targets en azul, Targets en verde con su
// derrota de waypoints).
//
// Herramientas propias además de puntero y medir:
//   - ubicar un buque antes de abrir la sesión (click = posición, arrastrar = rumbo)
//   - insertar un DT (click = posición, arrastrar = vector: rumbo y velocidad)
//   - insertar un Target (click en cada waypoint, doble click o Enter para terminar)

import type { BlancoDTO, CartaParseada, EstadoBuqueDTO, Participacion, PuntoTraza, WaypointDTO } from '../../shared/types.js';
import { VistaCarta, type InfoMouse } from '../carta/vista-carta.js';

const ESLORA_M = 92;
const COLOR_OS = { relleno: '#e00000', borde: '#600000', centro: '#ffff00' };
const COLOR_DT = { relleno: '#0050e0', borde: '#001a60', centro: '#ffffff' };
const COLOR_T = { relleno: '#008000', borde: '#003000', centro: '#ffffff' };
const COLOR_VECTOR_OS = '#e00000';
const COLOR_VECTOR_DT = '#0050e0';
const COLOR_DERROTA = '#006000';
const COLOR_TRAZA = '#800080';
const COLOR_SEGMENTOS = 'rgba(255, 80, 80, 0.7)';

interface Ubicando {
  ownshipIndex: number;
  lat: number | null;
  lon: number | null;
  headingDeg: number;
  arrastrando: boolean;
}

export type Insercion = 'DT' | 'T' | null;

// Posición de cualquier objeto seleccionable, identificado como "OS-1", "DT-2", "T-1".
interface Posicionado {
  id: string;
  lat: number;
  lon: number;
  headingDeg: number;
}

export class CartaInstructor extends VistaCarta {
  vectorMin = 6;
  anillosNm: number | null = null;
  mostrarTrazas = true;
  mostrarSegmentos = false;
  mostrarBuques = true;
  mostrarBlancos = true;
  // Objeto de referencia: el cursor mide marcación y distancia desde él.
  seleccionado: string | null = null;
  // Velocidad de los tramos de un Target nuevo.
  velTramoKn = 10;

  private buques: EstadoBuqueDTO[] = [];
  private blancos: BlancoDTO[] = [];
  private trazas = new Map<number, PuntoTraza[]>();
  private iniciales: Participacion[] = [];
  private ubicando: Ubicando | null = null;
  private insercion: Insercion = null;
  private dtNuevo: { lat: number; lon: number; lat2: number; lon2: number } | null = null;
  private derrotaNueva: WaypointDTO[] = [];

  onSeleccion: (id: string | null) => void = () => {};
  onMouse: (info: (InfoMouse & { rangoNm: number | null; marcacion: number | null }) | null) => void = () => {};
  onUbicado: (ownshipIndex: number, lat: number, lon: number, headingDeg: number) => void = () => {};
  onCrearDT: (lat: number, lon: number, rumbo: number, velKn: number) => void = () => {};
  onCrearTarget: (waypoints: WaypointDTO[]) => void = () => {};
  onFinInsercion: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, carta: CartaParseada, imagen: HTMLImageElement) {
    super(canvas, carta, imagen);
    this.resize(true);
    window.addEventListener('keydown', (e) => {
      if (this.insercion === 'T' && e.key === 'Enter') this.terminarTarget();
    });
  }

  // ----- Datos -----------------------------------------------------------------
  setBuques(buques: EstadoBuqueDTO[]): void {
    this.buques = buques;
    this.dibujar();
  }

  setBlancos(blancos: BlancoDTO[]): void {
    this.blancos = blancos;
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

  seleccionar(id: string | null): void {
    this.seleccionado = id;
    this.dibujar();
    this.onSeleccion(id);
  }

  // Encuadra un objeto (buque o blanco) en el centro de la carta.
  centrarObjeto(id: string): void {
    const p = this.posicionados().find((x) => x.id === id);
    if (p) this.centrarEn(p.lat, p.lon);
  }

  ajustarACarta(): void {
    this.centroX = this.imagen.naturalWidth / 2;
    this.centroY = this.imagen.naturalHeight / 2;
    this.resize(true);
  }

  // ----- Ubicar buque (antes de abrir) ---------------------------------------------
  iniciarUbicar(ownshipIndex: number): void {
    this.cancelarInsercion();
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

  // ----- Insertar blancos ------------------------------------------------------------
  iniciarInsercion(tipo: Insercion): void {
    this.cancelarUbicar();
    this.insercion = tipo;
    this.dtNuevo = null;
    this.derrotaNueva = [];
    this.canvas.classList.toggle('ubicando', tipo !== null);
    this.dibujar();
  }

  cancelarInsercion(): void {
    if (this.insercion === null) return;
    this.insercion = null;
    this.dtNuevo = null;
    this.derrotaNueva = [];
    this.canvas.classList.remove('ubicando');
    this.dibujar();
    this.onFinInsercion();
  }

  insercionActual(): Insercion {
    return this.insercion;
  }

  private terminarTarget(): void {
    // El doble click que termina la derrota también cuenta como dos clicks
    // sueltos: descartamos los waypoints repetidos en el mismo lugar.
    const derrota: WaypointDTO[] = [];
    for (const w of this.derrotaNueva) {
      const prev = derrota[derrota.length - 1];
      if (prev && VistaCarta.rangoYMarcacion(prev.lat, prev.lon, w.lat, w.lon).nm < 0.01) continue;
      derrota.push({ ...w });
    }
    if (derrota.length >= 2) this.onCrearTarget(derrota);
    this.cancelarInsercion();
  }

  // ----- Mouse ------------------------------------------------------------------
  protected override alPresionar(x: number, y: number): boolean {
    const [lat, lon] = this.cartaALatLon(...this.pantallaACarta(x, y));
    if (this.ubicando) {
      Object.assign(this.ubicando, { lat, lon, headingDeg: 0, arrastrando: true });
      return true;
    }
    if (this.insercion === 'DT') {
      this.dtNuevo = { lat, lon, lat2: lat, lon2: lon };
      return true;
    }
    if (this.insercion === 'T') {
      this.derrotaNueva.push({ lat, lon, velKn: this.velTramoKn });
      this.dibujar();
      return true;
    }
    if (this.herramienta !== 'puntero') return false;
    // Click sobre un buque o un blanco: pasa a ser la referencia.
    for (const p of this.posicionados()) {
      const [px, py] = this.latLonAPantalla(p.lat, p.lon);
      if (Math.hypot(px - x, py - y) < 14) {
        this.seleccionar(p.id === this.seleccionado ? null : p.id);
        return true;
      }
    }
    return false;
  }

  protected override alMover(x: number, y: number, apretado: boolean): void {
    const [lat, lon] = this.cartaALatLon(...this.pantallaACarta(x, y));
    const u = this.ubicando;
    if (u && u.arrastrando && u.lat !== null && u.lon !== null && apretado) {
      // Rumbo desde el punto fijado hacia el cursor (0 = norte, horario).
      u.headingDeg = VistaCarta.rangoYMarcacion(u.lat, u.lon, lat, lon).deg;
    }
    if (this.dtNuevo && apretado) {
      this.dtNuevo.lat2 = lat;
      this.dtNuevo.lon2 = lon;
    }
  }

  protected override alSoltar(): void {
    const u = this.ubicando;
    if (u && u.arrastrando && u.lat !== null && u.lon !== null) {
      const { ownshipIndex, lat, lon, headingDeg } = u;
      this.cancelarUbicar();
      this.onUbicado(ownshipIndex, lat, lon, headingDeg);
      return;
    }
    if (this.dtNuevo) {
      // El largo del vector es la distancia que recorre en "vectorMin" minutos.
      const { lat, lon, lat2, lon2 } = this.dtNuevo;
      const rb = VistaCarta.rangoYMarcacion(lat, lon, lat2, lon2);
      const velKn = Math.min(40, (rb.nm * 60) / this.vectorMin);
      this.onCrearDT(lat, lon, rb.nm > 0.001 ? rb.deg : 0, Math.round(velKn * 10) / 10);
      this.cancelarInsercion();
    }
  }

  protected override alDobleClick(): void {
    if (this.insercion === 'T') this.terminarTarget();
  }

  protected override alMoverMouse(info: InfoMouse | null): void {
    if (!info) {
      this.onMouse(null);
      return;
    }
    const ref = this.posicionados().find((b) => b.id === this.seleccionado);
    const rb = ref ? VistaCarta.rangoYMarcacion(ref.lat, ref.lon, info.lat, info.lon) : null;
    this.onMouse({ ...info, rangoNm: rb?.nm ?? null, marcacion: rb?.deg ?? null });
  }

  // Todo lo que se puede seleccionar: los buques vivos (o sus posiciones
  // iniciales antes de abrir) y los blancos.
  private posicionados(): Posicionado[] {
    const os: Posicionado[] = this.buques.length > 0
      ? this.buques.map((b) => ({ id: `OS-${b.ownshipIndex}`, lat: b.lat, lon: b.lon, headingDeg: b.headingDeg }))
      : this.iniciales
        .filter((p) => p.latInicial !== null && p.lonInicial !== null)
        .map((p) => ({ id: `OS-${p.ownshipIndex}`, lat: p.latInicial!, lon: p.lonInicial!, headingDeg: p.headingInicial ?? 0 }));
    return [...os, ...this.blancos.map((b) => ({ id: b.id, lat: b.lat, lon: b.lon, headingDeg: b.headingDeg }))];
  }

  // ----- Dibujo -----------------------------------------------------------------
  protected override dibujarEncima(): void {
    if (this.mostrarSegmentos) this.dibujarSegmentos();
    const ref = this.posicionados().find((b) => b.id === this.seleccionado);
    if (ref && this.anillosNm) this.dibujarAnillos(ref.lat, ref.lon, this.anillosNm, COLOR_TRAZA);

    if (this.mostrarBlancos) {
      for (const b of this.blancos) this.dibujarBlanco(b);
    }

    if (this.buques.length > 0) {
      if (this.mostrarTrazas) {
        for (const b of this.buques) this.dibujarRecorrido(this.trazas.get(b.ownshipIndex) ?? [], 30, b, COLOR_TRAZA);
      }
      if (this.mostrarBuques) {
        for (const b of this.buques) {
          this.dibujarVectorRumbo(b.lat, b.lon, b.headingDeg, b.velocidadKn, this.vectorMin, COLOR_VECTOR_OS);
          this.dibujarCasco(b.lat, b.lon, b.headingDeg, ESLORA_M, COLOR_OS);
          this.dibujarEtiqueta(`OS-${b.ownshipIndex}`, b.lat, b.lon, '#ffff00');
        }
      }
    } else {
      // Antes de abrir: posiciones iniciales en trazo claro ("todavía no están vivos").
      for (const p of this.posicionados().filter((x) => x.id.startsWith('OS-'))) {
        const os = Number(p.id.slice(3));
        if (this.ubicando?.ownshipIndex === os && this.ubicando.lat !== null) continue;
        this.dibujarCasco(p.lat, p.lon, p.headingDeg, ESLORA_M, { relleno: 'rgba(224,0,0,0.35)', borde: '#e00000', centro: '#ffff00' });
        this.dibujarEtiqueta(p.id, p.lat, p.lon, 'rgba(255,255,0,0.6)');
      }
    }

    this.dibujarUbicando();
    this.dibujarInsercion();
  }

  private dibujarBlanco(b: BlancoDTO): void {
    const ctx = this.ctx;
    if (b.tipo === 'T') {
      // Derrota: tramos a trazos entre waypoints numerados (como en el Melipal).
      const pts = b.waypoints.map((w) => this.latLonAPantalla(w.lat, w.lon));
      ctx.strokeStyle = COLOR_DERROTA;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '12px Tahoma, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      pts.forEach(([x, y], i) => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.strokeStyle = COLOR_DERROTA;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 3, y - 3, 6, 6);
        ctx.fillStyle = COLOR_DERROTA;
        ctx.fillText(String(i), x + 5, y - 3);
      });
      this.dibujarCasco(b.lat, b.lon, b.headingDeg, ESLORA_M, COLOR_T);
      this.dibujarEtiqueta(b.id, b.lat, b.lon, '#b8f0b8');
      return;
    }
    // DT: vector actual y, si todavía está cambiando, el rumbo pretendido en punteado.
    this.dibujarVectorRumbo(b.lat, b.lon, b.headingDeg, b.velocidadKn, this.vectorMin, COLOR_VECTOR_DT);
    if (Math.abs(b.rumboPretendido - b.headingDeg) > 0.5 || Math.abs(b.velPretendida - b.velocidadKn) > 0.1) {
      ctx.setLineDash([3, 3]);
      this.dibujarVectorRumbo(b.lat, b.lon, b.rumboPretendido, Math.max(b.velPretendida, 1), this.vectorMin, COLOR_VECTOR_DT);
      ctx.setLineDash([]);
    }
    this.dibujarCasco(b.lat, b.lon, b.headingDeg, ESLORA_M, COLOR_DT);
    this.dibujarEtiqueta(b.id, b.lat, b.lon, '#b8d8ff');
  }

  private dibujarUbicando(): void {
    const u = this.ubicando;
    if (!u || u.lat === null || u.lon === null) return;
    this.dibujarCasco(u.lat, u.lon, u.headingDeg, ESLORA_M, { relleno: '#ffc800', borde: '#000', centro: '#e00000' });
    const [x, y] = this.latLonAPantalla(u.lat, u.lon);
    const a = ((u.headingDeg - 90) * Math.PI) / 180;
    this.ctx.strokeStyle = '#ffc800';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x + Math.cos(a) * 80, y + Math.sin(a) * 80);
    this.ctx.stroke();
    this.dibujarEtiqueta(`OS-${u.ownshipIndex}`, u.lat, u.lon, '#ffff00', `${u.headingDeg.toFixed(0)}°`);
  }

  // Vista previa mientras se inserta un DT (vector) o un Target (derrota).
  private dibujarInsercion(): void {
    const ctx = this.ctx;
    if (this.dtNuevo) {
      const { lat, lon, lat2, lon2 } = this.dtNuevo;
      const [x1, y1] = this.latLonAPantalla(lat, lon);
      const [x2, y2] = this.latLonAPantalla(lat2, lon2);
      const rb = VistaCarta.rangoYMarcacion(lat, lon, lat2, lon2);
      this.dibujarCasco(lat, lon, rb.deg, ESLORA_M, COLOR_DT);
      ctx.strokeStyle = COLOR_VECTOR_DT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const vel = Math.min(40, (rb.nm * 60) / this.vectorMin);
      this.cartelito(`${rb.deg.toFixed(0)}°  ${vel.toFixed(1)} kn`, x2, y2);
    }
    if (this.insercion === 'T' && this.derrotaNueva.length > 0) {
      const pts = this.derrotaNueva.map((w) => this.latLonAPantalla(w.lat, w.lon));
      const cursor = this.mouseCarta ? this.cartaAPantalla(...this.mouseCarta) : null;
      ctx.strokeStyle = COLOR_DERROTA;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (cursor) ctx.lineTo(...cursor);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y] of pts) {
        ctx.fillStyle = COLOR_DERROTA;
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
      if (cursor) this.cartelito('Doble click o Enter para terminar', cursor[0], cursor[1]);
    }
  }

  private cartelito(texto: string, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.font = '12px Tahoma, sans-serif';
    const w = ctx.measureText(texto).width + 8;
    ctx.fillStyle = '#ffffe1';
    ctx.fillRect(x + 8, y - 20, w, 18);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 8, y - 20, w, 18);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(texto, x + 12, y - 11);
  }

  // Etiqueta "OS-01" / "DT-02" arriba a la derecha del buque, como en el original.
  private dibujarEtiqueta(id: string, lat: number, lon: number, fondo: string, extra?: string): void {
    const ctx = this.ctx;
    const [x, y] = this.latLonAPantalla(lat, lon);
    const [tipo, n] = id.split('-');
    const texto = `${tipo}-${String(n).padStart(2, '0')}${extra ? ` ${extra}` : ''}`;
    ctx.font = 'bold 11px Tahoma, Verdana, sans-serif';
    const w = ctx.measureText(texto).width + 6;
    const bx = x + 8;
    const by = y - 24;
    ctx.fillStyle = fondo;
    ctx.fillRect(bx, by, w, 14);
    if (id === this.seleccionado) {
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
