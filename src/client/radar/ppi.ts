// Pantalla PPI (Plan Position Indicator) del radar, con el aspecto del radar
// del Melipal (ver docs/referencia/melipal-radar.png): fondo azul oscuro, ecos
// amarillos, anillos blancos y un bisel negro con la escala de marcaciones.
//
// Render sin canvas offscreen: cada frame se redibuja todo.
//   - Los ecos se dibujan siempre en intensidad base y el sector recién
//     barrido (detrás de la antena) se repinta más brillante, simulando la
//     persistencia del fósforo.
//   - El clutter de mar es un conjunto de puntos alrededor del buque propio
//     que se re-sortea en cada vuelta de antena; el control SEA lo atenúa.

import type { CartaParseada, EstadoBuqueDTO } from '../../shared/types.js';
import { segmentoARelativo, segmentoFueraDeAlcance, latLonAMillasRel } from './coords.js';
import type { DatosArpa } from './arpa.js';

export type PPIMode = 'NORTH_UP' | 'HEAD_UP' | 'COURSE_UP';

export const ESCALAS_NM = [0.5, 0.75, 1.5, 3, 6, 12, 24] as const;
export type EscalaNm = (typeof ESCALAS_NM)[number];

// Intervalo entre anillos para cada escala (como los radares reales: la
// cantidad de anillos queda entre 3 y 6).
export const ANILLOS_NM: Record<EscalaNm, number> = {
  0.5: 0.1, 0.75: 0.25, 1.5: 0.25, 3: 0.5, 6: 1, 12: 2, 24: 4,
};

export interface MarcaEBL { activa: boolean; bearingTrue: number }
export interface MarcaVRM { activa: boolean; rangoNm: number }

export interface PPIConfig {
  escalaNm: EscalaNm;
  mode: PPIMode;
  courseUpDeg: number;          // rumbo fijado al elegir COURSE UP
  ebl: [MarcaEBL, MarcaEBL];
  vrm: [MarcaVRM, MarcaVRM];
  // Display
  anillos: boolean;
  marcaProa: boolean;
  marcaPopa: boolean;
  escalaMarcaciones: boolean;
  lineaBarrido: boolean;
  colorNoche: boolean;
  // Transmisor y señal
  transmitiendo: boolean;
  ganancia: number;             // 0..100
  sintonia: number;             // 0..100 (óptimo ~75)
  mar: number;                  // 0..100: cuánto se suprime el clutter de mar
  autoClutter: boolean;
  // ARPA
  arpaVisible: boolean;
  vector: 'TRUE' | 'RELATIVE';
  vectorMin: number;
  cpaLimiteNm: number;
  tcpaLimiteMin: number;
  mostrarLimiteCpa: boolean;
}

// Paleta de colores del Melipal (medida sobre la captura del manual).
const PALETA = {
  dia: {
    fondo: '#636c93', ppi: '#00007e', eco: [255, 255, 0], clutter: [190, 190, 150],
    anillo: 'rgba(255, 255, 255, 0.7)', linea: '#ffffff', texto: '#e8e8e8',
    ebl: '#ffffff', vrm: '#ffffff', arpa: '#00e0ff', peligro: '#ff2020', zona: '#20d080',
  },
  noche: {
    fondo: '#2a2e40', ppi: '#000026', eco: [170, 150, 0], clutter: [110, 110, 80],
    anillo: 'rgba(170, 170, 170, 0.5)', linea: '#a0a0a0', texto: '#a8a8a8',
    ebl: '#b0b0b0', vrm: '#b0b0b0', arpa: '#0090b0', peligro: '#c01010', zona: '#108050',
  },
};

// Un radar náutico real gira a 24 RPM; para uso pedagógico en pantalla chica
// conviene un ritmo más pausado (12 RPM = 1 vuelta cada 5 s).
const ANTENNA_RPM = 12;
const ANTENNA_DEG_PER_SEC = (ANTENNA_RPM * 360) / 60;

const BASE_ALPHA = 0.55;
const GLOW_STEPS: { degHasta: number; alpha: number }[] = [
  { degHasta: 10,  alpha: 1.00 },
  { degHasta: 25,  alpha: 0.95 },
  { degHasta: 45,  alpha: 0.88 },
  { degHasta: 70,  alpha: 0.82 },
  { degHasta: 100, alpha: 0.76 },
  { degHasta: 140, alpha: 0.70 },
  { degHasta: 190, alpha: 0.65 },
  { degHasta: 250, alpha: 0.60 },
];

// Ancho del bisel negro con la escala de marcaciones (px).
const BISEL = 26;
// Clutter de mar: cantidad de puntos y alcance típico (millas).
const CLUTTER_PUNTOS = 900;
const CLUTTER_ESCALA_NM = 0.6;

// Lo mínimo que hace falta para dibujar el eco de otro buque (alumno o blanco).
export interface EcoBuque {
  lat: number;
  lon: number;
  headingDeg: number;
}

export interface Geometria {
  cx: number;
  cy: number;
  radio: number; // radio útil del PPI (sin bisel), px CSS
}

export class PPI {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ancho = 0;
  private alto = 0;
  private dpr = 1;
  private antennaAngleDeg = 0;
  private lastFrameMs = 0;
  private clutter: { bearing: number; rangoNm: number; fuerza: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;
    this.sortearClutter();
  }

  resize(): void {
    const host = this.canvas.parentElement;
    if (!host) return;
    this.ancho = host.clientWidth;
    this.alto = host.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.ancho}px`;
    this.canvas.style.height = `${this.alto}px`;
    this.canvas.width = Math.floor(this.ancho * this.dpr);
    this.canvas.height = Math.floor(this.alto * this.dpr);
  }

  // Centro y radio del PPI en px CSS relativos al canvas. radar.ts lo usa
  // para traducir clicks a marcación/distancia.
  geometria(): Geometria {
    // Si el panel es casi cuadrado no queda lugar en las esquinas para los
    // textos (HEADING, OWN SHIP, GAIN…): achicamos el círculo hasta un 9 %.
    // En un panel apaisado, como la pantalla original, sobra lugar y no se toca.
    const menor = Math.min(this.ancho, this.alto);
    const aspecto = Math.max(this.ancho, this.alto) / Math.max(1, menor);
    const achique = Math.max(0, Math.min(1, (1.45 - aspecto) / 0.45)) * 0.09 * menor;
    return {
      cx: this.ancho / 2,
      cy: this.alto / 2,
      radio: Math.max(10, menor / 2 - BISEL - 4 - achique),
    };
  }

  // Rotación (grados) que se aplica al contenido según el modo: en North Up
  // no rota; en Head Up / Course Up la proa / el rumbo quedan arriba.
  static rotacion(config: PPIConfig, ownShip: EstadoBuqueDTO | null): number {
    if (config.mode === 'HEAD_UP') return ownShip?.headingDeg ?? 0;
    if (config.mode === 'COURSE_UP') return config.courseUpDeg;
    return 0;
  }

  draw(
    ownShip: EstadoBuqueDTO | null,
    otherShips: EcoBuque[],
    carta: CartaParseada | null,
    config: PPIConfig,
    arpaTargets: DatosArpa[] = [],
  ): void {
    if (this.ancho <= 0 || this.alto <= 0) return;
    const pal = config.colorNoche ? PALETA.noche : PALETA.dia;

    const now = performance.now();
    const dtMs = this.lastFrameMs === 0 ? 16 : Math.min(100, now - this.lastFrameMs);
    this.lastFrameMs = now;

    const ctx = this.ctx;
    const { cx, cy, radio } = this.geometria();
    const pixelsPorMilla = radio / config.escalaNm;
    const rot = PPI.rotacion(config, ownShip);

    // Avanzar antena; al completar una vuelta, nuevo sorteo de clutter.
    const anterior = this.antennaAngleDeg;
    this.antennaAngleDeg = (this.antennaAngleDeg + (ANTENNA_DEG_PER_SEC * dtMs) / 1000) % 360;
    if (this.antennaAngleDeg < anterior) this.sortearClutter();
    const antena = this.antennaAngleDeg;

    // Fondo del panel, bisel negro y disco azul del PPI.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = pal.fondo;
    ctx.fillRect(0, 0, this.ancho, this.alto);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(cx, cy, radio + BISEL, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pal.ppi;
    ctx.beginPath();
    ctx.arc(cx, cy, radio, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);

    if (config.escalaMarcaciones) this.dibujarEscalaMarcaciones(ctx, radio, rot, pal.texto);

    if (!config.transmitiendo) {
      // Stand by: el transmisor no emite, no hay ecos ni barrido.
      ctx.fillStyle = pal.texto;
      ctx.font = 'bold 18px Tahoma, Verdana, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('STAND BY', 0, 0);
      ctx.restore();
      return;
    }

    // Contenido rotado según el modo de presentación.
    ctx.save();
    ctx.rotate((-rot * Math.PI) / 180);
    ctx.beginPath();
    ctx.arc(0, 0, radio, 0, Math.PI * 2);
    ctx.clip();

    // La ganancia y la sintonía escalan la intensidad de todos los ecos.
    const sintonia = 1 - Math.min(1, Math.abs(config.sintonia - 75) / 120);
    const senal = (0.25 + (0.75 * config.ganancia) / 100) * sintonia;

    if (ownShip) {
      const pintarEcos = (alpha: number) => {
        this.dibujarClutter(ctx, config, pixelsPorMilla, pal.clutter, alpha * senal);
        if (carta) this.dibujarEcosCarta(ctx, ownShip, carta, config.escalaNm, pixelsPorMilla, pal.eco, alpha * senal);
        this.dibujarEcosBuques(ctx, ownShip, otherShips, config.escalaNm, pixelsPorMilla, pal.eco, Math.min(1, alpha * senal + 0.2));
      };
      pintarEcos(BASE_ALPHA);
      // Afterglow escalonado detrás de la antena (de lo más viejo a lo más nuevo).
      for (let i = GLOW_STEPS.length - 1; i >= 0; i--) {
        const step = GLOW_STEPS[i]!;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radio, ((antena - step.degHasta - 90) * Math.PI) / 180, ((antena - 90) * Math.PI) / 180);
        ctx.closePath();
        ctx.clip();
        pintarEcos(step.alpha);
        ctx.restore();
      }
    }

    if (config.anillos) this.dibujarAnillos(ctx, radio, config.escalaNm, pal.anillo);
    if (ownShip) this.dibujarMarcasProaPopa(ctx, radio, ownShip, config, pal.linea);
    if (config.lineaBarrido) this.dibujarAntena(ctx, radio, antena, pal.linea);
    config.ebl.forEach((e, i) => {
      if (e.activa) this.dibujarEBL(ctx, radio, e.bearingTrue, pal.ebl, i);
    });
    config.vrm.forEach((v, i) => {
      if (v.activa) this.dibujarVRM(ctx, v.rangoNm, pixelsPorMilla, radio, pal.vrm, i);
    });
    if (config.mostrarLimiteCpa) this.dibujarLimiteCpa(ctx, config.cpaLimiteNm, pixelsPorMilla, pal.zona);
    if (config.arpaVisible && ownShip && arpaTargets.length > 0) {
      this.dibujarArpaTargets(ctx, arpaTargets, ownShip, config, pixelsPorMilla, radio, pal);
    }
    ctx.restore();

    // Buque propio en el centro.
    ctx.fillStyle = pal.linea;
    ctx.beginPath();
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private sortearClutter(): void {
    // Distribución exponencial en distancia: mucho cerca del buque, poco lejos.
    this.clutter = Array.from({ length: CLUTTER_PUNTOS }, () => ({
      bearing: Math.random() * 360,
      rangoNm: -Math.log(1 - Math.random()) * CLUTTER_ESCALA_NM,
      fuerza: Math.random(),
    }));
  }

  private dibujarClutter(
    ctx: CanvasRenderingContext2D,
    config: PPIConfig,
    pixelsPorMilla: number,
    color: number[],
    alpha: number,
  ): void {
    // El control SEA (o AUTO CLUTTER) sube el umbral: solo pasan los puntos
    // más fuertes, y cada vez menos lejos del buque.
    const supresion = config.autoClutter ? Math.max(config.mar, 70) : config.mar;
    const umbral = supresion / 100;
    ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    const lado = Math.max(1.5, Math.min(3, pixelsPorMilla * 0.02));
    for (const p of this.clutter) {
      if (p.fuerza * Math.exp(-p.rangoNm / 1.5) < umbral) continue;
      if (p.rangoNm > config.escalaNm) continue;
      const a = ((p.bearing - 90) * Math.PI) / 180;
      const r = p.rangoNm * pixelsPorMilla;
      ctx.fillRect(Math.cos(a) * r, Math.sin(a) * r, lado, lado);
    }
  }

  private dibujarEcosCarta(
    ctx: CanvasRenderingContext2D,
    ownShip: EstadoBuqueDTO,
    carta: CartaParseada,
    alcanceNm: number,
    pixelsPorMilla: number,
    color: number[],
    alpha: number,
  ): void {
    ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    // La costa devuelve un eco "gordo": más ancho en escalas cortas.
    ctx.lineWidth = Math.max(1.5, Math.min(4, pixelsPorMilla * 0.03));
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const seg of carta.segmentos) {
      const rel = segmentoARelativo(seg, carta, ownShip.lat, ownShip.lon);
      if (segmentoFueraDeAlcance(rel, alcanceNm)) continue;
      ctx.moveTo(rel.x1 * pixelsPorMilla, -rel.y1 * pixelsPorMilla);
      ctx.lineTo(rel.x2 * pixelsPorMilla, -rel.y2 * pixelsPorMilla);
    }
    ctx.stroke();
  }

  private dibujarEcosBuques(
    ctx: CanvasRenderingContext2D,
    ownShip: EstadoBuqueDTO,
    otherShips: EcoBuque[],
    alcanceNm: number,
    pixelsPorMilla: number,
    color: number[],
    alpha: number,
  ): void {
    ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    for (const otro of otherShips) {
      const rel = latLonAMillasRel(otro.lat, otro.lon, ownShip.lat, ownShip.lon);
      if (Math.hypot(rel.xE, rel.yN) > alcanceNm) continue;
      // Eco alargado en el sentido del buque, como en la pantalla original.
      ctx.save();
      ctx.translate(rel.xE * pixelsPorMilla, -rel.yN * pixelsPorMilla);
      ctx.rotate((otro.headingDeg * Math.PI) / 180);
      ctx.fillRect(-2.5, -5, 5, 10);
      ctx.restore();
    }
  }

  private dibujarEscalaMarcaciones(ctx: CanvasRenderingContext2D, radio: number, rot: number, color: string): void {
    // La escala es verdadera: en Head Up / Course Up gira con el contenido.
    ctx.save();
    ctx.rotate((-rot * Math.PI) / 180);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let b = 0; b < 360; b += 1) {
      const largo = b % 10 === 0 ? 7 : b % 5 === 0 ? 4.5 : 2.5;
      const a = ((b - 90) * Math.PI) / 180;
      ctx.moveTo(Math.cos(a) * radio, Math.sin(a) * radio);
      ctx.lineTo(Math.cos(a) * (radio + largo), Math.sin(a) * (radio + largo));
    }
    ctx.stroke();
    ctx.restore();
    // Los números van derechos (sin rotar), como en la pantalla original.
    ctx.fillStyle = color;
    ctx.font = '10px Tahoma, Verdana, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let b = 0; b < 360; b += 10) {
      const a = ((b - rot - 90) * Math.PI) / 180;
      const r = radio + 16;
      ctx.fillText(b.toString().padStart(3, '0'), Math.cos(a) * r, Math.sin(a) * r);
    }
  }

  private dibujarAnillos(ctx: CanvasRenderingContext2D, radio: number, escalaNm: EscalaNm, color: string): void {
    const paso = ANILLOS_NM[escalaNm];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = paso; d <= escalaNm + 1e-6; d += paso) {
      const r = (d / escalaNm) * radio;
      ctx.moveTo(r, 0);
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  private dibujarMarcasProaPopa(
    ctx: CanvasRenderingContext2D,
    radio: number,
    ownShip: EstadoBuqueDTO,
    config: PPIConfig,
    color: string,
  ): void {
    ctx.save();
    ctx.rotate((ownShip.headingDeg * Math.PI) / 180);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    if (config.marcaProa) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -radio);
      ctx.stroke();
    }
    if (config.marcaPopa) {
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, radio);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  private dibujarAntena(ctx: CanvasRenderingContext2D, radio: number, angleDeg: number, color: string): void {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * radio, Math.sin(a) * radio);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Líneas de marcación: EBL 1 a trazos, EBL 2 punteada, para distinguirlas.
  private dibujarEBL(ctx: CanvasRenderingContext2D, radio: number, bearingTrue: number, color: string, i: number): void {
    ctx.save();
    ctx.rotate(((bearingTrue - 90) * Math.PI) / 180);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash(i === 0 ? [8, 5] : [2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(radio, 0);
    ctx.stroke();
    ctx.restore();
  }

  private dibujarVRM(
    ctx: CanvasRenderingContext2D,
    rangoNm: number,
    pixelsPorMilla: number,
    radioMax: number,
    color: string,
    i: number,
  ): void {
    const r = Math.min(radioMax, Math.max(2, rangoNm * pixelsPorMilla));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash(i === 0 ? [8, 5] : [2, 4]);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private dibujarLimiteCpa(ctx: CanvasRenderingContext2D, cpaNm: number, pixelsPorMilla: number, color: string): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, cpaNm * pixelsPorMilla, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Símbolo ARPA: cuadrado alrededor del eco + vector (verdadero o relativo)
  // de la longitud elegida en minutos + número de blanco. En rojo si viola los
  // límites de CPA/TCPA.
  private dibujarArpaTargets(
    ctx: CanvasRenderingContext2D,
    targets: DatosArpa[],
    ownShip: EstadoBuqueDTO,
    config: PPIConfig,
    pixelsPorMilla: number,
    radioMax: number,
    pal: (typeof PALETA)['dia'],
  ): void {
    const ownE = Math.sin((ownShip.headingDeg * Math.PI) / 180) * ownShip.velocidadKn;
    const ownN = Math.cos((ownShip.headingDeg * Math.PI) / 180) * ownShip.velocidadKn;
    for (const t of targets) {
      const ang = ((t.bearingTrue - 90) * Math.PI) / 180;
      const r = t.rangeNm * pixelsPorMilla;
      if (r > radioMax + 10) continue;
      const x = Math.cos(ang) * r;
      const y = Math.sin(ang) * r;
      const color = esPeligroso(t, config) ? pal.peligro : pal.arpa;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.3;
      ctx.strokeRect(x - 7, y - 7, 14, 14);

      if (!Number.isNaN(t.courseDeg)) {
        let vE = Math.sin((t.courseDeg * Math.PI) / 180) * t.speedKn;
        let vN = Math.cos((t.courseDeg * Math.PI) / 180) * t.speedKn;
        if (config.vector === 'RELATIVE') {
          vE -= ownE;
          vN -= ownN;
        }
        const largoNm = (config.vectorMin / 60);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + vE * largoNm * pixelsPorMilla, y - vN * largoNm * pixelsPorMilla);
        ctx.stroke();
      }
      ctx.font = '11px Tahoma, Verdana, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(t.etiqueta, x + 8, y + 6);
    }
  }
}

export function esPeligroso(t: DatosArpa, config: Pick<PPIConfig, 'cpaLimiteNm' | 'tcpaLimiteMin'>): boolean {
  return t.cpaNm !== null && t.tcpaMin !== null
    && t.cpaNm < config.cpaLimiteNm && t.tcpaMin > 0 && t.tcpaMin < config.tcpaLimiteMin;
}
