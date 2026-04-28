// Catálogo de modelos de buques disponibles para los Own Ships.
//
// IMPORTANTE: en MVP 3 hay un único modelo (M140) hardcodeado con datos
// extraídos a mano del archivo legacy data/fleet.cfg. La física que usamos
// es simple a propósito: una constante de tiempo para que la velocidad
// converja al objetivo, y una tasa de giro proporcional al ángulo del timón.
//
// La iteración "calibración física" (BACKLOG.md) reemplazará este módulo
// por un parser completo del fleet.cfg + modelo Nomoto que use los
// coeficientes hidrodinámicos reales.

import type { PosicionTelegrafo } from '../../shared/types.js';
export type { TelegrafoId } from '../../shared/types.js';

export interface ModeloBuque {
  sigla: string;
  nombre: string;

  // Dimensiones físicas, en metros
  largoM: number;
  mangaM: number;
  caladoM: number;

  // Operacionales
  velMaxKn: number;       // velocidad máxima hacia adelante (knots)
  velMinKn: number;       // velocidad mínima (negativa = atrás) (knots)
  maxRudderDeg: number;   // ángulo máximo del timón (grados)

  // Posiciones del telégrafo: ordenadas de Full Astern a Full Ahead.
  // Cada entrada mapea a una velocidad objetivo en knots.
  telegrafo: PosicionTelegrafo[];

  // Constantes de la física simplificada
  // tau = constante de tiempo de aceleración/frenado (segundos hasta ~63%
  // de la velocidad objetivo)
  tauVelocidad: number;
  // Tasa máxima de giro a timón completo, en grados/segundo
  maxTurnRateDegPerSec: number;
}

export const M140: ModeloBuque = {
  sigla: 'M140',
  nombre: 'Meko 140',
  largoM: 92,
  mangaM: 12,
  caladoM: 4.5,
  velMaxKn: 27.5,
  velMinKn: -4.4,
  maxRudderDeg: 35,
  // Velocidades objetivo derivadas de las posiciones del telégrafo del M140
  // tomadas del fleet.cfg (RPM máx ahead = 400, full astern = -400).
  telegrafo: [
    { id: 'FAS',  nombre: 'Full Astern',      velObjetivoKn: -4.4 },
    { id: 'HAS',  nombre: 'Half Astern',      velObjetivoKn: -3.0 },
    { id: 'SAS',  nombre: 'Slow Astern',      velObjetivoKn: -2.0 },
    { id: 'DSAS', nombre: 'Dead Slow Astern', velObjetivoKn: -1.0 },
    { id: 'STOP', nombre: 'Stop',             velObjetivoKn: 0    },
    { id: 'DSAH', nombre: 'Dead Slow Ahead',  velObjetivoKn: 5    },
    { id: 'SAH',  nombre: 'Slow Ahead',       velObjetivoKn: 10   },
    { id: 'HAH',  nombre: 'Half Ahead',       velObjetivoKn: 18   },
    { id: 'FAH',  nombre: 'Full Ahead',       velObjetivoKn: 27.5 },
  ],
  tauVelocidad: 35,           // ~35 segundos para alcanzar el 63% del objetivo
  maxTurnRateDegPerSec: 1.6,  // a timón 35°, gira ~1.6°/s
};

// Por ahora solo M140. Cuando hagamos la calibración con fleet.cfg, esto
// se llena con los 22 modelos del archivo.
export const CATALOGO_BUQUES: Record<string, ModeloBuque> = {
  M140,
};

export function getModeloPorSigla(sigla: string): ModeloBuque {
  const m = CATALOGO_BUQUES[sigla];
  if (!m) throw new Error(`Modelo de buque desconocido: ${sigla}`);
  return m;
}

export const MODELO_DEFAULT = M140;
