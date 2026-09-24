# Convierte los gráficos originales de la consola del Melipal (BMP del módulo
# Comando, release 2011) a PNG dentro de public/img/consola/.
#
# Se corre una sola vez (o cuando cambie la fuente). Requiere Pillow.
#   python scripts/importar-consola-melipal.py "<ruta a ...\Comando>"
#
# Los nombres de salida están normalizados (minúsculas, sin espacios) para
# poder referenciarlos cómodos desde CSS/TS.

import shutil
import sys
from pathlib import Path

from PIL import Image

ORIGEN_DEFAULT = (
    Path(__file__).resolve().parents[2]
    / 'SIMULADOR 2011' / 'SIMULADOR FULL' / '_Release Melipal Full Abril 2011' / 'Comando'
)
DESTINO = Path(__file__).resolve().parents[1] / 'public' / 'img' / 'consola'
DESTINO_FUENTE = Path(__file__).resolve().parents[1] / 'public' / 'fonts'

# origen (en IMGS/) → destino (en public/img/consola/)
ARCHIVOS = {
    'Steering-bg.bmp': 'steering-bg.png',
    'Log-bg.bmp': 'log-bg.png',
    'fondoVacio367x290.bmp': 'fondo-367x290.png',
    'fondoVacio275x290.bmp': 'fondo-275x290.png',
    'T-fixed.bmp': 'telegrafo-escala.png',
    'r-rudder com.bmp': 'reloj-rudder-command.png',
    'r-rudder ang.bmp': 'reloj-rudder-angle.png',
    'r-turn rate.bmp': 'reloj-turn-rate.png',
    'r-wind spd.bmp': 'reloj-wind-speed.png',
    'r-wind dir.bmp': 'reloj-wind-direction.png',
    'vhf2 negro.bmp': 'vhf.png',
    'RED.BMP': 'turnrate-rojo.png',
    'Green.bmp': 'turnrate-verde.png',
}
# Palancas: T-n = máquina de estribor (a la derecha de la escala),
# TI-n = máquina de babor (a la izquierda). n = 0 (Full Ahead) … 9 (Full Astern).
for n in range(10):
    ARCHIVOS[f'T-{n}.bmp'] = f'palanca-estribor-{n}.png'
    ARCHIVOS[f'TI-{n}.bmp'] = f'palanca-babor-{n}.png'
# Joystick de gobierno (PORT … STBD)
for pos in ['LL', 'L', 'C', 'R', 'RR']:
    ARCHIVOS[f'JYS-{pos}.BMP'] = f'joystick-{pos.lower()}.png'
# Botones: U = suelto, D = apretado. Las variantes "2" (39x34) son las que
# calzan con los fondos de los paneles.
BOTONES = {
    'BS-AL': 'alarm', 'BS-AU': 'auto', 'BS-EN': 'enter', 'BS-MA': 'manual', 'BS-PA': 'param',
    'BL-L1': 'log1', 'BL-L2': 'log2', 'BL-LF': 'logfail', 'BL-DR': 'distreset',
    'BL-UT': 'utc', 'BL-LO': 'local',
}
for origen, nombre in BOTONES.items():
    ARCHIVOS[f'{origen}U2.BMP'] = f'btn-{nombre}-up.png'
    ARCHIVOS[f'{origen}D2.BMP'] = f'btn-{nombre}-down.png'


def main() -> None:
    origen = Path(sys.argv[1]) if len(sys.argv) > 1 else ORIGEN_DEFAULT
    imgs = origen / 'IMGS'
    DESTINO.mkdir(parents=True, exist_ok=True)
    for src, dst in ARCHIVOS.items():
        Image.open(imgs / src).convert('RGB').save(DESTINO / dst, optimize=True)
    DESTINO_FUENTE.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(origen / '7segmen0.TTF', DESTINO_FUENTE / '7segmentos.ttf')
    print(f'{len(ARCHIVOS)} imagenes -> {DESTINO}')


if __name__ == '__main__':
    main()
