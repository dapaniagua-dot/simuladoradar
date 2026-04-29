// Pantalla PPI (Plan Position Indicator) del radar.
//
// Render simplificado sin canvas offscreen ni persistencia:
//   - Cada frame se redibuja todo desde cero sobre el canvas principal.
//   - La costa se dibuja siempre, en intensidad base baja.
//   - El sector recién barrido (detrás de la antena) se redibuja en intensidad
//     alta sobre el mismo, simulando el highlight del barrido.
//   - La antena gira a 24 RPM con una pequeña estela amarilla.
//
// Trade-off: sin persistencia tipo "fósforo CRT" auténtica, pero sin riesgo
// de acumulación visual ni blur subpíxel cuando el barco navega.

import type { CartaParseada, EstadoBuqueDTO } from '../../shared/types.js';
import { segmentoARelativo, segmentoFueraDeAlcance, latLonAMillasRel } from './coords.js';

export type PPIMode = 'NORTH_UP' | 'HEAD_UP';

export const ESCALAS_NM = [0.5, 0.75, 1.5, 3, 6, 12, 24] as const;
export type EscalaNm = (typeof ESCALAS_NM)[number];

export interface PPIConfig {
  escalaNm: EscalaNm;
  mode: PPIMode;
}

const ANTENNA_RPM = 24;
const ANTENNA_DEG_PER_SEC = (ANTENNA_RPM * 360) / 60;

// Ancho del "afterglow" detrás de la antena (en grados). Los ecos en ese
// sector se ven más brillantes que el resto, simulando el efecto del barrido.
const GLOW_DEG = 90;

export class PPI {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size = 0;
  private dpr = 1;
  private antennaAngleDeg = 0;
  private lastFrameMs = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;
  }

  resize(): void {
    const host = this.canvas.parentElement;
    if (!host) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    this.size = Math.min(w, h);
    this.dpr = window.devicePixelRatio || 1;
    const pxSize = Math.floor(this.size * this.dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.canvas.width = pxSize;
    this.canvas.height = pxSize;
  }

  // No-op en esta versión (no hay canvas de ecos persistente). Se mantiene
  // la firma para que radar.ts pueda llamarla al cambiar RANGE/MODE sin
  // que falle.
  clearEchoes(): void {
    // intencionalmente vacío
  }

  draw(
    ownShip: EstadoBuqueDTO | null,
    otherShips: EstadoBuqueDTO[],
    carta: CartaParseada | null,
    config: PPIConfig,
  ): void {
    const cssSize = this.size;
    if (cssSize <= 0) return;

    const now = performance.now();
    const dtMs = this.lastFrameMs === 0 ? 16 : Math.min(100, now - this.lastFrameMs);
    const dt = dtMs / 1000;
    this.lastFrameMs = now;

    const ctx = this.ctx;
    const cx = cssSize / 2;
    const cy = cssSize / 2;
    const radius = cssSize / 2 - 30;
    const pixelsPorMilla = radius / config.escalaNm;

    // Avanzar antena
    this.antennaAngleDeg = (this.antennaAngleDeg + ANTENNA_DEG_PER_SEC * dt) % 360;
    const antennaAngle = this.antennaAngleDeg;

    // Fondo negro
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cssSize, cssSize);

    // Trasladar al centro y aplicar rotación de Head Up sobre el contenido
    ctx.save();
    ctx.translate(cx, cy);
    if (config.mode === 'HEAD_UP' && ownShip) {
      ctx.rotate((-ownShip.headingDeg * Math.PI) / 180);
    }

    // Capa 1: ecos en intensidad baja (siempre visibles, recortado al círculo)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    if (ownShip && carta) {
      this.dibujarEcosCarta(ctx, ownShip, carta, config.escalaNm, pixelsPorMilla, 0.35);
    }
    if (ownShip) {
      this.dibujarEcosBuques(ctx, ownShip, otherShips, config.escalaNm, pixelsPorMilla, 0.55);
    }
    ctx.restore();

    // Capa 2: highlight del sector recién barrido (los últimos GLOW_DEG grados
    // detrás de la antena, en intensidad alta) recortado al círculo
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const aNew = ((antennaAngle - 90) * Math.PI) / 180;
    const aOld = ((antennaAngle - GLOW_DEG - 90) * Math.PI) / 180;
    ctx.arc(0, 0, radius, aOld, aNew);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.clip();
    if (ownShip && carta) {
      this.dibujarEcosCarta(ctx, ownShip, carta, config.escalaNm, pixelsPorMilla, 1);
    }
    if (ownShip) {
      this.dibujarEcosBuques(ctx, ownShip, otherShips, config.escalaNm, pixelsPorMilla, 1);
    }
    ctx.restore();

    // Anillos / bearings / heading line / antena
    this.dibujarAnillos(ctx, radius, config.escalaNm);
    this.dibujarBearings(ctx, radius);
    this.dibujarHeadingLine(ctx, radius, ownShip, config.mode);
    this.dibujarAntena(ctx, radius, antennaAngle);

    ctx.restore();

    this.dibujarEscala(ctx, cssSize, config);
  }

  private dibujarEcosCarta(
    ctx: CanvasRenderingContext2D,
    ownShip: EstadoBuqueDTO,
    carta: CartaParseada,
    alcanceNm: number,
    pixelsPorMilla: number,
    alpha: number,
  ): void {
    ctx.strokeStyle = `rgba(120, 255, 150, ${alpha})`;
    ctx.lineWidth = 1.2;
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
    otherShips: EstadoBuqueDTO[],
    alcanceNm: number,
    pixelsPorMilla: number,
    alpha: number,
  ): void {
    ctx.fillStyle = `rgba(255, 120, 120, ${alpha})`;
    for (const otro of otherShips) {
      const rel = latLonAMillasRel(otro.lat, otro.lon, ownShip.lat, ownShip.lon);
      const dist = Math.hypot(rel.xE, rel.yN);
      if (dist > alcanceNm) continue;
      ctx.beginPath();
      ctx.arc(rel.xE * pixelsPorMilla, -rel.yN * pixelsPorMilla, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private dibujarAnillos(ctx: CanvasRenderingContext2D, radius: number, escalaNm: number): void {
    ctx.strokeStyle = 'rgba(0, 220, 100, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= 4; i++) {
      const r = (radius * i) / 4;
      ctx.moveTo(r, 0);
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.stroke();
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
    ctx.strokeStyle = 'rgba(0, 220, 100, 0.4)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(0, 220, 100, 0.85)';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let bearing = 0; bearing < 360; bearing += 10) {
      const major = bearing % 30 === 0;
      const angle = ((bearing - 90) * Math.PI) / 180;
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
    mode: PPIMode,
  ): void {
    ctx.fillStyle = 'rgba(255, 240, 80, 1)';
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    if (!ownShip) return;
    const angleDeg = mode === 'HEAD_UP' ? 0 : ownShip.headingDeg;
    ctx.save();
    ctx.rotate((angleDeg * Math.PI) / 180);
    ctx.strokeStyle = 'rgba(255, 240, 80, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -radius);
    ctx.stroke();
    ctx.restore();
  }

  private dibujarAntena(ctx: CanvasRenderingContext2D, radius: number, angleDeg: number): void {
    // Línea principal de la antena en el ángulo actual.
    const angle = ((angleDeg - 90) * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(180, 255, 200, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    ctx.stroke();
  }

  private dibujarEscala(ctx: CanvasRenderingContext2D, size: number, config: PPIConfig): void {
    ctx.fillStyle = 'rgba(0, 220, 100, 0.9)';
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = config.escalaNm < 1 ? config.escalaNm.toFixed(2) : config.escalaNm.toFixed(1);
    ctx.fillText(`RANGE ${label} NM`, 8, 8);
    ctx.fillText(`MODE  ${config.mode === 'HEAD_UP' ? 'HEAD UP' : 'NORTH UP'}`, 8, 26);
    ctx.fillText(`ANTENNA ${ANTENNA_RPM} RPM`, 8, size - 22);
  }
}
