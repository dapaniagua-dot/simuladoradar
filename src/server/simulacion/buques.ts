// Catálogo de modelos de buques disponibles para los Own Ships: los buques de
// río de la flota del Melipal que se usan en la ENF (fleet.cfg, importados por
// scripts/importar-flota-melipal.py).
//
// La física sigue siendo la simple (una constante de tiempo para la velocidad
// y una tasa de giro proporcional al timón), pero ahora cada buque tiene la
// suya. El fleet.cfg trae los coeficientes hidrodinámicos pero no las
// ecuaciones del motor de INVAP, y en varios buques están copiados de otro,
// así que no se usan (DECISIONS.md, D25).
//
// La escala parte del Meko 140, el único buque que tuvo el MVP y cuyo
// comportamiento ya se probó con Diego. Cada buque se escala desde él con sus
// datos reales (eslora, desplazamiento, velocidad máxima, RPM, velocidad del
// timón) y queda PROVISORIO hasta calibrarlo contra el Melipal.

import { FLOTA_MELIPAL } from '../../shared/flota-melipal.js';
import type { BuqueFlota, PosicionTelegrafo, TelegrafoId } from '../../shared/types.js';
export type { TelegrafoId } from '../../shared/types.js';

export interface ModeloBuque {
  sigla: string;
  nombre: string;
  motores: number;

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
  // Tasa de giro por empuje diferencial de las dos hélices (una Full Ahead y
  // la otra Full Astern), en grados/segundo. 0 si tiene una sola máquina.
  maxTurnRateDiferencialDegPerSec: number;
  // Velocidad a la que el timón real sigue al comandado, en grados/segundo.
  velTimonDegPorSeg: number;
  // false = valores escalados desde el M140, falta calibrar con el Melipal.
  calibrado: boolean;
}

const NOMBRES_TELEGRAFO: Record<TelegrafoId, string> = {
  FAS: 'Full Astern', HAS: 'Half Astern', SAS: 'Slow Astern', DSAS: 'Dead Slow Astern', STOP: 'Stop',
  DSAH: 'Dead Slow Ahead', SAH: 'Slow Ahead', HAH: 'Half Ahead', MAN: 'Manoeuvring', FAH: 'Full Ahead',
};
const ORDEN_TELEGRAFO: TelegrafoId[] = ['FAS', 'HAS', 'SAS', 'DSAS', 'STOP', 'DSAH', 'SAH', 'HAH', 'MAN', 'FAH'];

// Referencia de escala: el Meko 140 del MVP, con los valores que se venían usando.
const REF = {
  esloraM: 92,
  desplazamientoT: 1700,
  velMaxKn: 27.5,
  tauVelocidad: 35,          // ~35 segundos para alcanzar el 63% del objetivo
  maxTurnRateDegPerSec: 1.6, // a timón 35°, gira ~1.6°/s
  diferencialDegPerSec: 0.25, // ~15°/min con máquinas opuestas a full
  velTimonDegPorSeg: 4.0,
  velTimonFleet: 4.9,        // Angulo_Dot_Max del M140 en el fleet.cfg
};
function modeloDesdeFlota(f: BuqueFlota): ModeloBuque {
  // Hélice de paso fijo: la velocidad es aproximadamente proporcional a las
  // RPM, avante hasta la máxima y atrás hasta la mínima del fleet.cfg.
  const velLineal = (rpm: number) =>
    rpm >= 0 ? (f.velMaxKn * rpm) / Math.max(1, f.rpm.FAH) : (f.velMinKn * rpm) / Math.min(-1, f.rpm.FAS);
  const telegrafo = ORDEN_TELEGRAFO.map((id) => ({
    id,
    nombre: NOMBRES_TELEGRAFO[id],
    rpm: f.rpm[id],
    velObjetivoKn: Math.round(velLineal(f.rpm[id]) * 100) / 100,
  }));
  // Escalas desde el M140:
  // - arrancada y parada: por el coeficiente del Almirantazgo, el tiempo
  //   característico va como desplazamiento^(1/3) / velocidad máxima;
  // - giro: a igual timón, el radio de giro es proporcional a la eslora, así
  //   que la tasa va como velocidad / eslora;
  // - empuje diferencial: el momento crece con la manga pero la inercia con
  //   la eslora al cuadrado; se aproxima como 1 / eslora.
  const tau = REF.tauVelocidad * Math.cbrt(f.desplazamientoT / REF.desplazamientoT) * (REF.velMaxKn / f.velMaxKn);
  const giro = REF.maxTurnRateDegPerSec * (f.velMaxKn / REF.velMaxKn) / (f.esloraM / REF.esloraM);
  return {
    sigla: f.sigla,
    nombre: f.nombre,
    motores: f.motores,
    largoM: f.esloraM,
    mangaM: f.mangaM,
    caladoM: f.caladoM,
    velMaxKn: f.velMaxKn,
    velMinKn: f.velMinKn,
    maxRudderDeg: f.anguloTimonMaxDeg,
    telegrafo,
    tauVelocidad: Math.max(5, tau),
    // Topes por si se suma un buque muy chico, que con la escala daría
    // giros absurdos.
    maxTurnRateDegPerSec: Math.min(8, giro),
    maxTurnRateDiferencialDegPerSec: f.motores < 2 ? 0
      : Math.min(2, REF.diferencialDegPerSec * (REF.esloraM / f.esloraM)),
    velTimonDegPorSeg: (REF.velTimonDegPorSeg * f.velTimonDegPorSeg) / REF.velTimonFleet,
    calibrado: false,
  };
}

export const CATALOGO_BUQUES: Record<string, ModeloBuque> = Object.fromEntries(
  FLOTA_MELIPAL.map((f) => [f.sigla, modeloDesdeFlota(f)]),
);

export function getModeloPorSigla(sigla: string): ModeloBuque {
  const m = CATALOGO_BUQUES[sigla];
  if (!m) throw new Error(`Modelo de buque desconocido: ${sigla}`);
  return m;
}

// Por defecto el Balizador: tamaño medio y dos máquinas (usa el telégrafo doble).
export const MODELO_DEFAULT = getModeloPorSigla('BALI');
