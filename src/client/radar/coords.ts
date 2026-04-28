// Conversión entre el sistema de coordenadas global de la carta y el sistema
// local del radar (millas al este / al norte desde la posición del barco propio).
//
// Convenciones:
//   - Lat positivo = norte; lat negativo = sur (Argentina = negativo).
//   - Lon positivo = este; lon negativo = oeste.
//   - En el PPI: theta=0° es norte (arriba), crece sentido horario.
//   - X local: positivo al este. Y local: positivo al norte.

import type { CartaParseada, CartaSegmento } from '../../shared/types.js';

const MILLAS_POR_GRADO_LAT = 60;

// Convierte (lat, lon) globales a (xMillas_E, yMillas_N) relativas al barco.
// El factor de millas por grado de longitud depende de la latitud (Mercator).
export function latLonAMillasRel(
  lat: number,
  lon: number,
  ownLat: number,
  ownLon: number,
): { xE: number; yN: number } {
  const factorLon = Math.cos((ownLat * Math.PI) / 180) * MILLAS_POR_GRADO_LAT;
  const xE = (lon - ownLon) * factorLon;
  const yN = (lat - ownLat) * MILLAS_POR_GRADO_LAT;
  return { xE, yN };
}

// Toma un segmento del .map (cuyas coords nativas están en millas
// X-este-desde-NW / Y-norte-desde-SE) y devuelve sus dos extremos como
// (xE, yN) relativos al barco.
export function segmentoARelativo(
  seg: CartaSegmento,
  carta: CartaParseada,
  ownLat: number,
  ownLon: number,
): { x1: number; y1: number; x2: number; y2: number } {
  // Vamos a convertir las coordenadas del segmento a lat/lon globales y luego
  // a millas relativas al barco. Usamos los corners de la carta como referencia.
  const { esquinaNW, esquinaSE, anchoMillas, altoMillas } = carta;

  // Para cada punto (xMillas, yMillas) del segmento:
  //   - xMillas crece hacia el este desde NW: lon = lonNW + xMillas/factorLon(lat)
  //   - yMillas crece hacia el norte desde SE: lat = latSE + yMillas/MILLAS_POR_GRADO_LAT
  // Donde latSE es la latitud del corner SE (más al sur).
  //
  // Para no recalcular factorLon en cada punto (sólo varía con la latitud
  // del punto, que aproximamos por el centro de la carta), usamos el factor
  // promedio de la carta. Es una aproximación buena para cartas chicas.
  const latPromedio = (esquinaNW.lat + esquinaSE.lat) / 2;
  const factorLonCarta = Math.cos((latPromedio * Math.PI) / 180) * MILLAS_POR_GRADO_LAT;

  const lat1 = esquinaSE.lat + seg.yMillas1 / MILLAS_POR_GRADO_LAT;
  const lon1 = esquinaNW.lon + seg.xMillas1 / factorLonCarta;
  const lat2 = esquinaSE.lat + seg.yMillas2 / MILLAS_POR_GRADO_LAT;
  const lon2 = esquinaNW.lon + seg.xMillas2 / factorLonCarta;

  // Aprovechamos también que cada segmento ya trae lat1/lon1/lat2/lon2 nativos
  // como respaldo. Los priorizamos: son más precisos que la conversión.
  const a = latLonAMillasRel(seg.lat1 || lat1, seg.lon1 || lon1, ownLat, ownLon);
  const b = latLonAMillasRel(seg.lat2 || lat2, seg.lon2 || lon2, ownLat, ownLon);

  // Suprimimos warnings de unused (los cálculos de fallback los dejamos por las dudas)
  void anchoMillas; void altoMillas;

  return { x1: a.xE, y1: a.yN, x2: b.xE, y2: b.yN };
}

// Test rápido: si el bounding box del segmento (en millas relativas) está
// completamente fuera del círculo de alcance, el segmento no contribuye al
// PPI y se puede descartar sin dibujarlo.
export function segmentoFueraDeAlcance(
  s: { x1: number; y1: number; x2: number; y2: number },
  alcanceNm: number,
): boolean {
  const margen = alcanceNm;
  // Si los dos extremos están claramente del mismo lado del cuadrado [-r,r]^2,
  // el segmento no toca el círculo. (No hace falta calcular distancia exacta.)
  if (s.x1 < -margen && s.x2 < -margen) return true;
  if (s.x1 > margen && s.x2 > margen) return true;
  if (s.y1 < -margen && s.y2 < -margen) return true;
  if (s.y1 > margen && s.y2 > margen) return true;
  return false;
}
