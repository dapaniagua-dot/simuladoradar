"""Importa la flota del Melipal (Instructor/Data/fleet.cfg) a
src/shared/flota-melipal.ts.

El formato de fleet.cfg no está documentado entero: Fleet.txt (2002) describe
una versión vieja. El orden real de los campos sale de parametros/Parametros.ini
del "Generador de archivo fleet.cfg" (Utils/instalador fleet_cfg.exe), que
coincide con el fleet.ini del mismo editor. Los campos del bow thruster solo
están si BowThruster_10 = 1.

Solo se exportan los datos confiables para todos los buques (medidas,
velocidades, RPM del telégrafo, timón). Las derivadas hidrodinámicas (Yv, Nr…)
no: en varios buques están copiadas de otro y sin las ecuaciones de INVAP no se
pueden usar (ver DECISIONS.md, D25).

Uso: python scripts/importar-flota-melipal.py [ruta a "_Release Melipal Full Abril 2011"]
"""

import json
import sys
from pathlib import Path

ORIGEN_DEFAULT = Path(__file__).resolve().parents[2] / 'SIMULADOR 2011' / 'SIMULADOR FULL' / '_Release Melipal Full Abril 2011'
DESTINO = Path(__file__).resolve().parents[1] / 'src' / 'shared' / 'flota-melipal.ts'

# Campos después de sigla, nombre y segmentos, en el orden de Parametros.ini.
CAMPOS = [
    'Altura_antena', 'Helice_pasofijovariable_01', 'Cantidad_motores', 'Altura_casco', 'Largo_casco',
    'Masa_barco', 'Constante_masaxlargo', 'Desplazamiento', 'Longitud', 'Altura', 'Calado',
    'Superficie_mojada', 'Rho', 'Coeficiente Block', 'Masa_agregada_al_Casco', 'Coeficiente_friccion_agua',
    'Coeficiente_WaveMaking', 'Coeficiente_Yv_Dot', 'Coeficiente_Yr_Dot', 'Coeficiente_Nv_Dot',
    'Coeficiente_Nr_Dot', 'Coeficiente_Y_v', 'Coeficiente_Y_r', 'Coeficiente_N_v', 'Coeficiente_N_r',
    'Coeficiente_Cf_ae_x', 'Coeficiente_Cf_ae_y', 'Coeficiente_A_ae_x', 'Coeficiente_A_ae_y',
    'Coeficiente_C_ae_M', 'PosXThruster', 'PosYThruster', 'Diametro', 'Wake', 'Coeficiente_ThrustDeduction',
    'Coeficiente_PDR', 'Coeficiente_AAE', 'Coeficiente_NPB', 'Coeficiente_MaxRPS', 'Coeficiente_DragCoef',
    'Coeficiente_PDRMax', 'Coeficiente_ATranvs', 'Coeficiente_DotRPSMax', 'PosXTimon', 'PosYTimon',
    'AreaTimon', 'LargoTimon', 'AltoTimon', 'AnguloStall', 'AnguloMaximo', 'Angulo_Dot_Max',
    'Coeficiente_CLift', 'Coeficiente_CT', 'Coeficiente_WaveMakingBack', 'Velocidad_maxima',
    'Velocidad_minima', 'Coeficiente_MaxAhead', 'Coeficiente_MaxManouver', 'Coeficiente_HalfAhead',
    'Coeficiente_SlowAhead', 'Coeficiente_DeadSlowAhead', 'Coeficiente_DeadSlowAstern',
    'Coeficiente_SlowAstern', 'Coeficiente_HalfAstern', 'Coeficiente_MaxAstern', 'Barco_pesquero_10',
    'Coeficiente_ShallowWater', 'BowThruster_10',
]
CAMPOS_BT = [
    'PosX_BT', 'PosY_BT', 'Diametro_BT', 'Wake_BT', 'ThrustDeduction_BT', 'PDR_BT', 'AAE_BT', 'NPB_BT',
    'MaxRPS_BT', 'DragCoef_BT', 'ATranvs_BT', 'DotRPSMax_BT',
]
CAMPOS_FINALES = ['Archivo_imagen', 'Archivo_modelo3d'] + [
    f'Punto_{i}_amarre_{e}' for i in range(1, 9) for e in 'xy'
] + ['Peso_ancla', 'Carga_rotura_ancla', 'Peso_cadena_ancla', 'Cantidad_anclas']

# No tiene sentido como buque propio.
EXCLUIDOS = {'HELI'}


def leer(ruta: Path) -> list[dict]:
    lineas = [l.strip() for l in ruta.read_text(encoding='latin-1').splitlines()]
    cantidad = int(lineas[0])
    i = 1
    buques = []
    for _ in range(cantidad):
        b = {'sigla': lineas[i], 'nombre': lineas[i + 1]}
        segmentos = int(lineas[i + 2].split()[0])
        i += 3 + segmentos
        for campo in CAMPOS:
            b[campo] = lineas[i]
            i += 1
        if b['BowThruster_10'] == '1':
            for campo in CAMPOS_BT:
                b[campo] = lineas[i]
                i += 1
        for campo in CAMPOS_FINALES:
            b[campo] = lineas[i]
            i += 1
        # Controles de que no nos corrimos de campo.
        assert b['Archivo_imagen'].lower().endswith(('.jpg', '.bmp', '.png')), (b['sigla'], b['Archivo_imagen'])
        assert b['Archivo_modelo3d'].lower().endswith('.3ds'), (b['sigla'], b['Archivo_modelo3d'])
        buques.append(b)
    assert i == len(lineas) or all(not l for l in lineas[i:]), f'sobran líneas desde {i}'
    return buques


def num(v: str) -> float:
    x = float(v)
    return int(x) if x == int(x) else round(x, 3)


def exportar(b: dict) -> dict:
    return {
        'sigla': b['sigla'],
        'nombre': b['nombre'],
        'motores': int(b['Cantidad_motores']),
        'desplazamientoT': num(b['Desplazamiento']),
        'esloraM': num(b['Longitud']),
        'mangaM': num(b['Altura']),
        'caladoM': num(b['Calado']),
        'velMaxKn': num(b['Velocidad_maxima']),
        'velMinKn': num(b['Velocidad_minima']),
        'anguloTimonMaxDeg': num(b['AnguloMaximo']),
        'velTimonDegPorSeg': num(b['Angulo_Dot_Max']),
        'rpm': {
            'FAH': num(b['Coeficiente_MaxAhead']),
            'MAN': num(b['Coeficiente_MaxManouver']),
            'HAH': num(b['Coeficiente_HalfAhead']),
            'SAH': num(b['Coeficiente_SlowAhead']),
            'DSAH': num(b['Coeficiente_DeadSlowAhead']),
            'STOP': 0,
            'DSAS': num(b['Coeficiente_DeadSlowAstern']),
            'SAS': num(b['Coeficiente_SlowAstern']),
            'HAS': num(b['Coeficiente_HalfAstern']),
            'FAS': num(b['Coeficiente_MaxAstern']),
        },
        'bowThruster': b['BowThruster_10'] == '1',
        'pesquero': b['Barco_pesquero_10'] == '1',
    }


def main() -> None:
    origen = Path(sys.argv[1]) if len(sys.argv) > 1 else ORIGEN_DEFAULT
    buques = [exportar(b) for b in leer(origen / 'Instructor' / 'Data' / 'fleet.cfg') if b['sigla'] not in EXCLUIDOS]
    cuerpo = json.dumps(buques, ensure_ascii=False, indent=2)
    DESTINO.write_text(
        '// GENERADO por scripts/importar-flota-melipal.py a partir del fleet.cfg\n'
        '// del Melipal. No editar a mano: volver a correr el script.\n\n'
        "import type { BuqueFlota } from './types.js';\n\n"
        f'export const FLOTA_MELIPAL: BuqueFlota[] = {cuerpo};\n',
        encoding='utf-8', newline='\n',
    )
    for b in buques:
        print(f"{b['sigla']:5} {b['nombre']:26} {b['esloraM']:>6} m {b['desplazamientoT']:>7} t "
              f"{b['velMaxKn']:>6} kn  motores {b['motores']}  FAH {b['rpm']['FAH']}")
    print(f'{len(buques)} buques -> {DESTINO}')


if __name__ == '__main__':
    main()
