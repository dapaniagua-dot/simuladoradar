// Pantalla PPI (Plan Position Indicator) del radar.
//
// El PPI es un display polar centrado en el buque propio: el norte queda
// arriba (en modo "North Up"), los blancos aparecen en la posición relativa
// (rho = distancia, theta = bearing). Se dibuja sobre un canvas con un
// "armazón" estable (anillos, heading line, escala) y una capa de ecos
// que se actualizan a 24 RPM.
//
// Esta clase maneja sólo la parte visual y geométrica. Los datos (posición
// del propio, alcance, ecos detectados) se le pasan desde fuera.

import type { CartaParseada, EstadoBuqueDTO } from '../../shared/types.js';
import { segmentoARelativo, segmentoFueraDeAlcance, latLonAMillasRel } from './coords.js';

export type PPIMode = 'NORTH_UP' | 'HEAD_UP';

// Escalas estándar de un radar náutico (millas náuticas).
export const ESCALAS_NM = [0.5, 0.75, 1.5, 3, 6, 12, 24] as const;
export type EscalaNm = (typeof ESCALAS_NM)[number];

export interface PPIConfig {
  escalaNm: EscalaNm;
  mode: PPIMode;
}

export class PPI {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size = 0; // tamaño del canvas en CSS px (cuadrado)
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;
  }

  // Ajusta el canvas al tamaño del contenedor padre, manteniendo cuadrado.
  resize(): void {
    const host = this.canvas.parentElement;
    if (!host) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    this.size = Math.min(w, h);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.canvas.width = Math.floor(this.size * this.dpr);
    this.canvas.height = Math.floor(this.size * this.dpr);
  }

  // Dibuja el PPI completo sobre el canvas. Llamar a 60 fps cuando haya barrido,
  // o cada vez que llega un tick si todavía no tenemos animación.
  draw(
    ownShip: EstadoBuqueDTO | null,
    otherShips: EstadoBuqueDTO[],
    carta: CartaParseada | null,
    config: PPIConfig,
  ): void {
    const ctx = this.ctx;
    const cssSize = this.size;
    if (cssSize <= 0) return;

    // Fondo negro sobre todo el canvas.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cssSize, cssSize);

    // Centro del PPI y radio del círculo en pixels.
    const cx = cssSize / 2;
    const cy = cssSize / 2;
    const radius = cssSize / 2 - 30; // margen para etiquetas

    // pixelsPorMilla: cuántos pixels representa una milla náutica.
    const pixelsPorMilla = radius / config.escalaNm;

    // Trasladar el origen al centro y rotar según el modo.
    ctx.save();
    ctx.translate(cx, cy);
    if (config.mode === 'HEAD_UP' && ownShip) {
      // En "Head Up" la proa apunta arriba: rotamos el mundo en sentido contrario.
      ctx.rotate((-ownShip.headingDeg * Math.PI) / 180);
    }

    // Recortamos el dibujo de ecos al círculo del PPI.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    if (ownShip && carta) {
      this.dibujarEcosCarta(ctx, ownShip, carta, config.escalaNm, pixelsPorMilla);
    }
    if (ownShip) {
      this.dibujarEcosBuques(ctx, ownShip, otherShips, config.escalaNm, pixelsPorMilla);
    }
    ctx.restore();

    this.dibujarAnillos(ctx, radius, config.escalaNm);
    this.dibujarBearings(ctx, radius);
    this.dibujarHeadingLine(ctx, radius, ownShip);

    ctx.restore();

    this.dibujarEscala(ctx, cssSize, config);
  }

  // Dibuja los ecos del entorno (segmentos de la carta proyectados sobre el PPI
  // con coordenadas relativas al barco). Cada segmento se filtra primero por
  // bounding box; los que pasan se dibujan como línea verde brillante.
  private dibujarEcosCarta(
    ctx: CanvasRenderingContext2D,
    ownShip: EstadoBuqueDTO,
    carta: CartaParseada,
    alcanceNm: number,
    pixelsPorMilla: number,
  ): void {
    ctx.strokeStyle = 'rgba(80, 255, 130, 0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    let dibujados = 0;
    for (const seg of carta.segmentos) {
      const rel = segmentoARelativo(seg, carta, ownShip.lat, ownShip.lon);
      if (segmentoFueraDeAlcance(rel, alcanceNm)) continue;

      // Convertir millas relativas a pixels del PPI.
      // En el mundo: x = millas al este, y = millas al norte.
      // En el canvas: +X derecha (norte arriba ya rotado), +Y abajo.
      // theta=0 al norte → millas al norte (yN positivo) van a pixel.y negativo.
      const px1 = rel.x1 * pixelsPorMilla;
      const py1 = -rel.y1 * pixelsPorMilla;
      const px2 = rel.x2 * pixelsPorMilla;
      const py2 = -rel.y2 * pixelsPorMilla;
      ctx.moveTo(px1, py1);
      ctx.lineTo(px2, py2);
      dibujados++;
    }
    ctx.stroke();
    void dibujados; // (en el futuro se puede mostrar como métrica de carga)
  }

  private dibujarEcosBuques(
    ctx: CanvasRenderingContext2D,
    ownShip: EstadoBuqueDTO,
    otherShips: EstadoBuqueDTO[],
    alcanceNm: number,
    pixelsPorMilla: number,
  ): void {
    ctx.fillStyle = 'rgba(255, 80, 80, 0.95)';
    for (const otro of otherShips) {
      const rel = latLonAMillasRel(otro.lat, otro.lon, ownShip.lat, ownShip.lon);
      const dist = Math.hypot(rel.xE, rel.yN);
      if (dist > alcanceNm) continue;
      const px = rel.xE * pixelsPorMilla;
      const py = -rel.yN * pixelsPorMilla;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private dibujarAnillos(ctx: CanvasRenderingContext2D, radius: number, escalaNm: number): void {
    // Mostramos 4 anillos (cuartos de la escala) y el círculo exterior.
    ctx.strokeStyle = 'rgba(0, 220, 100, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= 4; i++) {
      const r = (radius * i) / 4;
      ctx.moveTo(r, 0);
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.stroke();

    // Etiqueta de cada anillo: distancia en millas
    ctx.fillStyle = 'rgba(0, 220, 100, 0.7)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 1; i <= 4; i++) {
      const r = (radius * i) / 4;
      const dist = (escalaNm * i) / 4;
      const label = dist < 1 ? dist.toFixed(2) : dist.toFixed(1);
      ctx.fillText(`${label}`, r + 4, -2);
    }
  }

  private dibujarBearings(ctx: CanvasRenderingContext2D, radius: number): void {
    // Marcas cada 30° + etiquetas cada 30°. Las marcas chicas cada 10°.
    ctx.strokeStyle = 'rgba(0, 220, 100, 0.4)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(0, 220, 100, 0.85)';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let bearing = 0; bearing < 360; bearing += 10) {
      const major = bearing % 30 === 0;
      const angle = ((bearing - 90) * Math.PI) / 180; // 0° = norte (arriba)
      const r1 = radius - (major ? 12 : 6);
      const r2 = radius;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * r1, Math.sin(angle) * r1);
      ctx.lineTo(Math.cos(angle) * r2, Math.sin(angle) * r2);
      ctx.stroke();
      if (major) {
        const lr = radius + 14;
        const label = bearing.toString().padStart(3, '0');
        ctx.fillText(label, Math.cos(angle) * lr, Math.sin(angle) * lr);
      }
    }
  }

  private dibujarHeadingLine(
    ctx: CanvasRenderingContext2D,
    radius: number,
    ownShip: EstadoBuqueDTO | null,
  ): void {
    // En modo NORTH_UP la heading line está rotada según el heading del barco.
    // En modo HEAD_UP el canvas ya está rotado, así que la línea apunta arriba.
    if (!ownShip) return;
    ctx.save();
    ctx.rotate((ownShip.headingDeg * Math.PI) / 180);
    ctx.strokeStyle = 'rgba(255, 240, 80, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -radius);
    ctx.stroke();
    ctx.restore();

    // Marca del centro (own ship)
    ctx.fillStyle = 'rgba(255, 240, 80, 1)';
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Banner abajo a la izquierda con la escala actual.
  private dibujarEscala(ctx: CanvasRenderingContext2D, size: number, config: PPIConfig): void {
    ctx.fillStyle = 'rgba(0, 220, 100, 0.9)';
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = config.escalaNm < 1 ? config.escalaNm.toFixed(2) : config.escalaNm.toFixed(1);
    ctx.fillText(`RANGE ${label} NM`, 8, 8);
    ctx.fillText(`MODE  ${config.mode === 'HEAD_UP' ? 'HEAD UP' : 'NORTH UP'}`, 8, 26);
  }
}
