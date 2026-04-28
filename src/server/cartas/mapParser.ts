import fs from 'node:fs/promises';
import type { CartaParseada, CartaSegmento, CartaCoord } from '../../shared/types.js';

// Convierte grados, minutos y segundos a grados decimales.
// El signo se respeta a partir del campo `grados` (que llega negativo en S/O).
function dmsADecimal(grados: number, minutos: number, segundos: number): number {
  const signo = grados < 0 ? -1 : 1;
  const absGrados = Math.abs(grados);
  return signo * (absGrados + minutos / 60 + segundos / 3600);
}

function tokens(linea: string): string[] {
  return linea.trim().split(/\s+/).filter(Boolean);
}

// Lee y parsea un archivo .map del simulador Melipal.
// Formato (texto plano, líneas):
//   1: nombre del raster (.bmp/.png) asociado — no se usa
//   2: 4 enteros — flag, cantidad de segmentos y dos enteros más; lo skipeamos
//      porque el ancho/alto reales se calculan a partir de los corners
//   3: 2 reales — alto en millas náuticas, ancho en millas náuticas
//   4: lon° lon' lon" lat° lat' lat" px py — esquina noroeste (Mercator)
//   5: idem — esquina sureste
//   6+: lat1 lon1 lat2 lon2 intensidad altura yMill1 xMill1 yMill2 xMill2
//      donde X = millas al este desde NW, Y = millas al norte desde SE.
export async function parseMapFile(rutaAbs: string, rasterUrl: string): Promise<CartaParseada> {
  const contenido = await fs.readFile(rutaAbs, 'utf8');
  const lineas = contenido.split(/\r?\n/);

  if (lineas.length < 5) {
    throw new Error(`Archivo .map inválido: solo ${lineas.length} líneas`);
  }

  // Línea 3: alto y ancho en millas náuticas. La línea 2 no nos sirve.
  const escala = tokens(lineas[2]!).map(Number);
  if (escala.length < 2) {
    throw new Error('Archivo .map inválido: línea 3 sin escala en millas');
  }
  const altoMillas = escala[0]!;
  const anchoMillas = escala[1]!;

  // Líneas 4 y 5: corners de la carta (Mercator).
  const esquinaNW = parseEsquinaLine(lineas[3]!);
  const esquinaSE = parseEsquinaLine(lineas[4]!);

  // Líneas 6+: segmentos.
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
      // En el archivo: yMill1, xMill1, yMill2, xMill2 (Y primero, X segundo).
      yMillas1: Number(t[6]),
      xMillas1: Number(t[7]),
      yMillas2: Number(t[8]),
      xMillas2: Number(t[9]),
    });
  }

  return {
    rasterUrl,
    altoMillas,
    anchoMillas,
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
  const lon = dmsADecimal(t[0]!, t[1]!, t[2]!);
  const lat = dmsADecimal(t[3]!, t[4]!, t[5]!);
  const px = t[6]!;
  const py = t[7]!;
  return { lat, lon, px, py };
}
