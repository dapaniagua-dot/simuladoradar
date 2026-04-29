// Lógica de ARPA (Automatic Radar Plotting Aid).
//
// Para MVP 4.9 hacemos sólo adquisición manual sobre OwnShips de la sesión.
// La detección automática y el ploteo sobre ecos de costa quedan para
// iteraciones futuras (requiere segmentación de ecos aislados vs continuos).
//
// Tracking: por cada blanco adquirido mantenemos un historial corto de
// posiciones lat/lon con timestamp. Con la primera y la última podemos
// estimar course (rumbo) y speed (velocidad).
//
// CPA / TCPA: asumimos trayectorias rectilíneas a velocidad constante para
// proyectar la posición futura del blanco vs la nuestra.

import type { EstadoBuqueDTO } from '../../shared/types.js';
import { latLonAMillasRel } from './coords.js';

const HISTORIAL_MAX = 30;            // ~3 segundos a 10 Hz, suficiente para estimar vector
const HISTORIAL_VENTANA_MS = 4000;   // descartamos muestras más viejas que esto

export interface MuestraTrack {
  t: number;       // timestamp ms
  lat: number;
  lon: number;
}

export interface BlancoArpa {
  // Identificador único del blanco. Por ahora usamos el ownshipIndex
  // del buque tracked (T-1, T-2, etc.).
  id: string;
  ownshipIndex: number;
  historial: MuestraTrack[];
}

// Resultado de evaluar un blanco contra el barco propio.
export interface DatosArpa {
  id: string;
  ownshipIndex: number;
  bearingTrue: number;     // bearing al blanco desde el barco propio (grados, 0..360)
  rangeNm: number;         // distancia al blanco (millas náuticas)
  courseDeg: number;       // rumbo del blanco (0..360, NaN si no hay datos)
  speedKn: number;         // velocidad del blanco (knots)
  cpaNm: number | null;    // distancia mínima de paso (NaN/null si no aplica)
  tcpaMin: number | null;  // tiempo hasta CPA en minutos (negativo = ya pasó)
}

export class ArpaTracker {
  private blancos = new Map<string, BlancoArpa>();

  adquirirOwnship(idx: number): string {
    const id = `T-${idx}`;
    if (!this.blancos.has(id)) {
      this.blancos.set(id, { id, ownshipIndex: idx, historial: [] });
    }
    return id;
  }

  ceaseTrack(id: string): void {
    this.blancos.delete(id);
  }

  ceaseAll(): void {
    this.blancos.clear();
  }

  estaTracking(idx: number): boolean {
    return this.blancos.has(`T-${idx}`);
  }

  // Llamar en cada tick con la lista de buques. Agrega muestras al historial
  // de los blancos tracked y descarta los blancos cuyo buque desapareció.
  procesarTick(tickT: number, buques: EstadoBuqueDTO[]): void {
    const porIdx = new Map(buques.map((b) => [b.ownshipIndex, b]));
    for (const blanco of this.blancos.values()) {
      const b = porIdx.get(blanco.ownshipIndex);
      if (!b) {
        // El blanco desapareció (sesión cerrada o alumno removido).
        continue;
      }
      blanco.historial.push({ t: tickT, lat: b.lat, lon: b.lon });
      // Acotar al máximo y por ventana temporal.
      while (blanco.historial.length > HISTORIAL_MAX) blanco.historial.shift();
      while (blanco.historial.length > 1 && tickT - blanco.historial[0]!.t > HISTORIAL_VENTANA_MS) {
        blanco.historial.shift();
      }
    }
  }

  evaluar(ownShip: EstadoBuqueDTO, buques: EstadoBuqueDTO[]): DatosArpa[] {
    const result: DatosArpa[] = [];
    const porIdx = new Map(buques.map((b) => [b.ownshipIndex, b]));
    for (const blanco of this.blancos.values()) {
      const b = porIdx.get(blanco.ownshipIndex);
      if (!b) continue;
      // Bearing y range desde el barco propio al blanco (en el frame actual).
      const rel = latLonAMillasRel(b.lat, b.lon, ownShip.lat, ownShip.lon);
      const rangeNm = Math.hypot(rel.xE, rel.yN);
      let bearingTrue = (Math.atan2(rel.xE, rel.yN) * 180) / Math.PI;
      bearingTrue = ((bearingTrue % 360) + 360) % 360;

      // Course / speed del blanco a partir del historial.
      let courseDeg = NaN;
      let speedKn = 0;
      const h = blanco.historial;
      if (h.length >= 2) {
        const a = h[0]!;
        const z = h[h.length - 1]!;
        const dtSec = (z.t - a.t) / 1000;
        if (dtSec > 0.2) {
          const desp = latLonAMillasRel(z.lat, z.lon, a.lat, a.lon);
          const distNm = Math.hypot(desp.xE, desp.yN);
          speedKn = (distNm / dtSec) * 3600;
          if (distNm > 0.0005) {
            courseDeg = ((Math.atan2(desp.xE, desp.yN) * 180) / Math.PI + 360) % 360;
          }
        }
      }

      // CPA / TCPA. Velocidades en millas/segundo en componentes (E, N).
      const ownVE = (Math.sin((ownShip.headingDeg * Math.PI) / 180) * ownShip.velocidadKn) / 3600;
      const ownVN = (Math.cos((ownShip.headingDeg * Math.PI) / 180) * ownShip.velocidadKn) / 3600;
      const tgtVE = !Number.isNaN(courseDeg)
        ? (Math.sin((courseDeg * Math.PI) / 180) * speedKn) / 3600
        : 0;
      const tgtVN = !Number.isNaN(courseDeg)
        ? (Math.cos((courseDeg * Math.PI) / 180) * speedKn) / 3600
        : 0;
      const vRelE = tgtVE - ownVE;
      const vRelN = tgtVN - ownVN;
      const vRelMag2 = vRelE * vRelE + vRelN * vRelN;

      let cpaNm: number | null = null;
      let tcpaMin: number | null = null;
      if (vRelMag2 > 1e-12) {
        // tcpa (segundos) = - (p · vRel) / |vRel|^2
        const tcpaSec = -(rel.xE * vRelE + rel.yN * vRelN) / vRelMag2;
        const xCpa = rel.xE + vRelE * tcpaSec;
        const yCpa = rel.yN + vRelN * tcpaSec;
        cpaNm = Math.hypot(xCpa, yCpa);
        tcpaMin = tcpaSec / 60;
      } else {
        cpaNm = rangeNm; // velocidad relativa cero → mantenemos distancia actual
        tcpaMin = null;
      }

      result.push({
        id: blanco.id,
        ownshipIndex: blanco.ownshipIndex,
        bearingTrue,
        rangeNm,
        courseDeg,
        speedKn,
        cpaNm,
        tcpaMin,
      });
    }
    return result;
  }

  todos(): BlancoArpa[] {
    return [...this.blancos.values()];
  }
}
