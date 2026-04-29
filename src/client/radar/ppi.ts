// Pantalla PPI (Plan Position Indicator) del radar.
//
// Estructura de render con persistencia tipo CRT:
//
//   echoesCanvas (offscreen): contiene los ecos "iluminados", en coordenadas
//     absolutas centradas en el barco (norte arriba, fijo). Cada frame se
//     atenúa un poco (fade) y se "iluminan" los ecos del sector barrido por
//     la antena en ese frame. Así los ecos viejos se desvanecen lentamente
//     dando el clásico afterglow del fósforo.
//
//   mainCanvas (visible): se redibuja completo cada frame. Componente:
//     - Fondo negro
//     - echoesCanvas (rotado si es modo Head Up)
//     - UI estática (anillos, bearings, heading line, antena, banner)
//
// La antena visible barre a 24 RPM (ANTENNA_RPM). La velocidad del fade
// está calibrada para que un eco persista ~3-4 segundos.

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
const ANTENNA_DEG_PER_SEC = (ANTENNA_RPM * 360) / 60; // = 144

// Fade aplicado en cada frame al canvas de ecos. 0.02 = ~2% por frame a 60fps.
// A esa tasa, un eco baja al 50% en ~35 frames (~0.6s) y al 5% en ~150 frames (~2.5s).
const FADE_PER_FRAME = 0.02;

export class PPI {
  private mainCanvas: HTMLCanvasElement;
  private mainCtx: CanvasRenderingContext2D;
  private echoesCanvas: HTMLCanvasElement;
  private echoesCtx: CanvasRenderingContext2D;

  private size = 0;
  private dpr = 1;
  private antennaAngleDeg = 0;
  private lastFrameMs = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.mainCanvas = canvas;
    const main = canvas.getContext('2d');
    if (!main) throw new Error('Canvas 2D no disponible');
    this.mainCtx = main;

    this.echoesCanvas = document.createElement('canvas');
    const echoes = this.echoesCanvas.getContext('2d');
    if (!echoes) throw new Error('Canvas offscreen no disponible');
    this.echoesCtx = echoes;
  }

  resize(): void {
    const host = this.mainCanvas.parentElement;
    if (!host) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    this.size = Math.min(w, h);
    this.dpr = window.devicePixelRatio || 1;
    const pxSize = Math.floor(this.size * this.dpr);

    this.mainCanvas.style.width = `${this.size}px`;
    this.mainCanvas.style.height = `${this.size}px`;
    this.mainCanvas.width = pxSize;
    this.mainCanvas.height = pxSize;

    this.echoesCanvas.width = pxSize;
    this.echoesCanvas.height = pxSize;
  }

  // Dibuja el PPI completo. Llamar a 60 fps para barrido suave.
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

    const cx = cssSize / 2;
    const cy = cssSize / 2;
    const radius = cssSize / 2 - 30;

    // Avanzar la antena
    const prevAngle = this.antennaAngleDeg;
    this.antennaAngleDeg = (this.antennaAngleDeg + ANTENNA_DEG_PER_SEC * dt) % 360;
    const newAngle = this.antennaAngleDeg;

    // ---------- 1) Fade del canvas de ecos ----------
    this.echoesCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.echoesCtx.globalCompositeOperation = 'destination-out';
    this.echoesCtx.fillStyle = `rgba(0, 0, 0, ${FADE_PER_FRAME})`;
    this.echoesCtx.fillRect(0, 0, cssSize, cssSize);
    this.echoesCtx.globalCompositeOperation = 'source-over';

    // ---------- 2) Iluminar ecos del sector barrido ----------
    if (ownShip) {
      this.echoesCtx.save();
      this.echoesCtx.translate(cx, cy);

      // Recortar a un sector entre prevAngle y newAngle. El bearing 0 está al
      // norte (-90° del eje x del canvas que apunta a la derecha).
      this.echoesCtx.beginPath();
      this.echoesCtx.moveTo(0, 0);
      const a1 = ((prevAngle - 90) * Math.PI) / 180;
      const a2 = ((newAngle - 90) * Math.PI) / 180;
      // Si cruzamos el 0/360 (newAngle < prevAngle), dibujamos el wrap en dos pasos.
      if (newAngle >= prevAngle) {
        this.echoesCtx.arc(0, 0, radius + 20, a1, a2);
      } else {
        this.echoesCtx.arc(0, 0, radius + 20, a1, ((360 - 90) * Math.PI) / 180);
        this.echoesCtx.lineTo(0, 0);
        this.echoesCtx.moveTo(0, 0);
        this.echoesCtx.arc(0, 0, radius + 20, ((-90) * Math.PI) / 180, a2);
      }
      this.echoesCtx.lineTo(0, 0);
      this.echoesCtx.closePath();
      this.echoesCtx.clip();

      const pixelsPorMilla = radius / config.escalaNm;
      if (carta) {
        this.dibujarEcosCarta(this.echoesCtx, ownShip, carta, config.escalaNm, pixelsPorMilla);
      }
      this.dibujarEcosBuques(this.echoesCtx, ownShip, otherShips, config.escalaNm, pixelsPorMilla);

      this.echoesCtx.restore();
    }

    // ---------- 3) Render del canvas principal ----------
    const ctx = this.mainCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cssSize, cssSize);

    // Componer la capa de ecos. En Head Up, rotamos según el heading actual.
    ctx.save();
    if (config.mode === 'HEAD_UP' && ownShip) {
      ctx.translate(cx, cy);
      ctx.rotate((-ownShip.headingDeg * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    ctx.drawImage(this.echoesCanvas, 0, 0, cssSize, cssSize);
    ctx.restore();

    // UI estática (no se desvanece).
    ctx.save();
    ctx.translate(cx, cy);
    this.dibujarAnillos(ctx, radius, config.escalaNm);
    this.dibujarBearings(ctx, radius);
    this.dibujarHeadingLine(ctx, radius, ownShip, config.mode);
    this.dibujarAntena(ctx, radius, newAngle);
    ctx.restore();

    this.dibujarEscala(ctx, cssSize, config);
  }

  private dibujarEcosCarta(
    ctx: CanvasRenderingContext2D,
    ownShip: EstadoBuqueDTO,
    carta: CartaParseada,
    alcanceNm: number,
    pixelsPorMilla: number,
  ): void {
    ctx.strokeStyle = 'rgba(120, 255, 150, 1)';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const seg of carta.segmentos) {
      const rel = segmentoARelativo(seg, carta, ownShip.lat, ownShip.lon);
      if (segmentoFueraDeAlcance(rel, alcanceNm)) continue;
      const px1 = rel.x1 * pixelsPorMilla;
      const py1 = -rel.y1 * pixelsPorMilla;
      const px2 = rel.x2 * pixelsPorMilla;
      const py2 = -rel.y2 * pixelsPorMilla;
      ctx.moveTo(px1, py1);
      ctx.lineTo(px2, py2);
    }
    ctx.stroke();
  }

  private dibujarEcosBuques(
    ctx: CanvasRenderingContext2D,
    ownShip: EstadoBuqueDTO,
    otherShips: EstadoBuqueDTO[],
    alcanceNm: number,
    pixelsPorMilla: number,
  ): void {
    ctx.fillStyle = 'rgba(255, 120, 120, 1)';
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
    // En Head Up la heading line siempre apunta arriba (la pantalla rota con el barco).
    // En North Up apunta al heading absoluto.
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

  // Línea más brillante que representa la antena del radar barriendo.
  // Arrastra un breve "estela" que ayuda a percibir el sentido del barrido.
  private dibujarAntena(ctx: CanvasRenderingContext2D, radius: number, angleDeg: number): void {
    const angle = ((angleDeg - 90) * Math.PI) / 180;
    // Estela: 5 líneas con opacidad decreciente, simulando movimiento.
    for (let i = 0; i < 5; i++) {
      const trailDeg = angleDeg - i * 4;
      const a = ((trailDeg - 90) * Math.PI) / 180;
      ctx.strokeStyle = `rgba(120, 255, 150, ${0.5 - i * 0.1})`;
      ctx.lineWidth = i === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.stroke();
    }
    void angle;
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
