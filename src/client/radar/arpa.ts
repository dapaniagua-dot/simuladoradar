// Lógica de ARPA (Automatic Radar Plotting Aid).
//
// Adquisición manual sobre los "contactos" que ve el radar: los buques de los
// otros alumnos y los blancos del instructor (Directed Targets y Targets). La
// detección automática y el ploteo sobre ecos de costa quedan para más
// adelante (requiere segmentar ecos aislados vs continuos).
//
// Tracking: por cada blanco adquirido mantenemos un historial corto de
// posiciones lat/lon con timestamp. Con la primera y la última estimamos
// course (rumbo) y speed (velocidad), como hace un ARPA real a partir de los
// ecos sucesivos (no le preguntamos al buque su rumbo).
//
// CPA / TCPA: asumimos trayectorias rectilíneas a velocidad constante para
// proyectar la posición futura del blanco vs la nuestra.

import type { EstadoBuqueDTO } from '../../shared/types.js';
import { latLonAMillasRel } from './coords.js';

const HISTORIAL_MAX = 30;            // ~3 segundos a 10 Hz, suficiente para estimar vector
const HISTORIAL_VENTANA_MS = 4000;   // descartamos muestras más viejas que esto

// Algo que el radar ve como eco y el ARPA puede seguir.
export interface Contacto {
  id: string;        // "OS-2", "DT-1", "T-3"
  etiqueta: string;  // lo que se muestra junto al símbolo ARPA
  lat: number;
  lon: number;
  headingDeg: number;
  velocidadKn: number;
}

export interface MuestraTrack {
  t: number;       // timestamp ms
  lat: number;
  lon: number;
}

export interface BlancoArpa {
  id: string;
  etiqueta: string;
  historial: MuestraTrack[];
}

// Resultado de evaluar un blanco contra el barco propio.
export interface DatosArpa {
  id: string;
  etiqueta: string;
  bearingTrue: number;     // bearing al blanco desde el barco propio (grados, 0..360)
  rangeNm: number;         // distancia al blanco (millas náuticas)
  courseDeg: number;       // rumbo del blanco (0..360, NaN si no hay datos)
  speedKn: number;         // velocidad del blanco (knots)
  cpaNm: number | null;    // distancia mínima de paso (NaN/null si no aplica)
  tcpaMin: number | null;  // tiempo hasta CPA en minutos (negativo = ya pasó)
}

export class ArpaTracker {
  private blancos = new Map<string, BlancoArpa>();

  adquirir(c: Pick<Contacto, 'id' | 'etiqueta'>): void {
    if (!this.blancos.has(c.id)) this.blancos.set(c.id, { id: c.id, etiqueta: c.etiqueta, historial: [] });
  }

  ceaseTrack(id: string): void {
    this.blancos.delete(id);
  }

  ceaseAll(): void {
    this.blancos.clear();
  }

  todos(): BlancoArpa[] {
    return [...this.blancos.values()];
  }

  // Llamar en cada tick con los contactos visibles. Agrega muestras al
  // historial de los blancos seguidos.
  procesarTick(tickT: number, contactos: Contacto[]): void {
    const porId = new Map(contactos.map((c) => [c.id, c]));
    for (const blanco of this.blancos.values()) {
      const c = porId.get(blanco.id);
      if (!c) continue;
      blanco.historial.push({ t: tickT, lat: c.lat, lon: c.lon });
      while (blanco.historial.length > HISTORIAL_MAX) blanco.historial.shift();
      while (blanco.historial.length > 1 && tickT - blanco.historial[0]!.t > HISTORIAL_VENTANA_MS) {
        blanco.historial.shift();
      }
    }
  }

  evaluar(ownShip: EstadoBuqueDTO, contactos: Contacto[]): DatosArpa[] {
    const result: DatosArpa[] = [];
    const porId = new Map(contactos.map((c) => [c.id, c]));
    for (const blanco of this.blancos.values()) {
      const c = porId.get(blanco.id);
      if (!c) continue;
      // Bearing y range desde el barco propio al blanco (en el frame actual).
      const rel = latLonAMillasRel(c.lat, c.lon, ownShip.lat, ownShip.lon);
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
      const tgtVE = !Number.isNaN(courseDeg) ? (Math.sin((courseDeg * Math.PI) / 180) * speedKn) / 3600 : 0;
      const tgtVN = !Number.isNaN(courseDeg) ? (Math.cos((courseDeg * Math.PI) / 180) * speedKn) / 3600 : 0;
      const vRelE = tgtVE - ownVE;
      const vRelN = tgtVN - ownVN;
      const vRelMag2 = vRelE * vRelE + vRelN * vRelN;

      let cpaNm: number | null = null;
      let tcpaMin: number | null = null;
      if (vRelMag2 > 1e-12) {
        // tcpa (segundos) = - (p · vRel) / |vRel|^2
        const tcpaSec = -(rel.xE * vRelE + rel.yN * vRelN) / vRelMag2;
        cpaNm = Math.hypot(rel.xE + vRelE * tcpaSec, rel.yN + vRelN * tcpaSec);
        tcpaMin = tcpaSec / 60;
      } else {
        cpaNm = rangeNm; // velocidad relativa cero → mantenemos distancia actual
        tcpaMin = null;
      }

      result.push({ id: blanco.id, etiqueta: blanco.etiqueta, bearingTrue, rangeNm, courseDeg, speedKn, cpaNm, tcpaMin });
    }
    return result;
  }
}
