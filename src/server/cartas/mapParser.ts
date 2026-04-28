import fs from 'node:fs/promises';
import type { CartaParseada, CartaSegmento, CartaCoord } from '../../shared/types.js';

// Convierte grados, minutos y segundos a grados decimales.
// Acepta valores negativos (S/O) por convención del archivo .map.
function dmsADecimal(grados: number, minutos: number, segundos: number): number {
  const signo = grados < 0 || (Object.is(grados, -0)) ? -1 : 1;
  const absGrados = Math.abs(grados);
  return signo * (absGrados + minutos / 60 + segundos / 3600);
}

// Tokeniza una línea respetando números separados por whitespace arbitrario.
function tokens(linea: string): string[] {
  return linea.trim().split(/\s+/).filter(Boolean);
}

// Lee y parsea un archivo .map del simulador Melipal.
// Formato (texto plano, líneas):
//   1: nombre del raster (.bmp/.png) asociado
//   2: 4 enteros — flag, ?, ancho, alto en pixeles
//   3: 2 reales — escala en millas (X, Y)
//   4: lon° lon' lon" lat° lat' lat" px py — esquina noroeste (Mercator)
//   5: idem — esquina sureste
//   6+: lat1 lon1 lat2 lon2 intensidad altura px1 py1 px2 py2 — segmentos
export async function parseMapFile(rutaAbs: string, rasterUrl: string): Promise<CartaParseada> {
  const contenido = await fs.readFile(rutaAbs, 'utf8');
  const lineas = contenido.split(/\r?\n/);

  if (lineas.length < 5) {
    throw new Error(`Archivo .map inválido: solo ${lineas.length} líneas`);
  }

  // Línea 2 — info de tamaño. El cuarto número es el alto, el tercero el ancho.
  const headerNums = tokens(lineas[1]!).map(Number);
  if (headerNums.length < 4) {
    throw new Error('Archivo .map inválido: línea 2 sin cuatro números');
  }
  const ancho = headerNums[2] ?? 0;
  const alto = headerNums[3] ?? 0;

  // Línea 4 — esquina NW
  const esquinaNW = parseEsquinaLine(lineas[3]!);
  // Línea 5 — esquina SE
  const esquinaSE = parseEsquinaLine(lineas[4]!);

  // Líneas 6+ : segmentos
  const segmentos: CartaSegmento[] = [];
  for (let i = 5; i < lineas.length; i++) {
    const linea = lineas[i];
    if (!linea || linea.trim() === '') continue;
    const t = tokens(linea);
    if (t.length < 10) continue;
    segmentos.push({
      lat1: Number(t[0]),
      lon1: Number(t[1]),
      lat2: Number(t[2]),
      lon2: Number(t[3]),
      intensidad: Number(t[4]),
      altura: Number(t[5]),
      px1: Number(t[6]),
      py1: Number(t[7]),
      px2: Number(t[8]),
      py2: Number(t[9]),
    });
  }

  return {
    rasterUrl,
    ancho,
    alto,
    esquinaNW,
    esquinaSE,
    segmentos,
  };
}

function parseEsquinaLine(linea: string): CartaCoord {
  const t = tokens(linea).map(Number);
  if (t.length < 8) {
    throw new Error(`Esquina inválida: "${linea}"`);
  }
  // Importante: el archivo respeta el signo en los grados (puede venir -57 36 48 = -57.6133...).
  // Los minutos y segundos siempre llegan positivos.
  const lon = dmsADecimal(t[0]!, t[1]!, t[2]!);
  const lat = dmsADecimal(t[3]!, t[4]!, t[5]!);
  const px = t[6]!;
  const py = t[7]!;
  return { lat, lon, px, py };
}
