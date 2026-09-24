# Convierte los gráficos del módulo Instructor del Melipal (carpeta Images del
# release 2011) a PNG en public/img/instructor/.
#
# Los íconos de 32x32 usan magenta (255, 0, 255) como color transparente.
# Se corre una sola vez. Requiere Pillow.
#   python scripts/importar-instructor-melipal.py ["<ruta a ...\Instructor\Images>"]

import sys
from pathlib import Path

from PIL import Image

ORIGEN_DEFAULT = (
    Path(__file__).resolve().parents[2]
    / 'SIMULADOR 2011' / 'SIMULADOR FULL' / '_Release Melipal Full Abril 2011' / 'Instructor' / 'Images'
)
DESTINO = Path(__file__).resolve().parents[1] / 'public' / 'img' / 'instructor'

# Íconos de la barra de herramientas (32x32, fondo magenta).
ICONOS = {
    'new.bmp': 'nuevo', 'open.bmp': 'abrir', 'save.bmp': 'guardar', 'delete.bmp': 'cerrar',
    'play.bmp': 'play', 'pausa.bmp': 'pausa', 'stop.bmp': 'stop', 'replay.bmp': 'replay',
    'os.bmp': 'os', 'dt.bmp': 'dt', 'target.bmp': 'target', 'rain.bmp': 'lluvia', 'bolla.bmp': 'boya',
    'point.bmp': 'puntero', 'fpoint.bmp': 'punto-p', 'spoint.bmp': 'punto-s', 'mesure.bmp': 'medir',
    'zoom.bmp': 'zoom',
}
# La tira todas.bmp trae dos íconos que no están sueltos: importar e info.
TIRA = {6: 'importar', 7: 'info'}
# Gráficos del panel izquierdo (se copian tal cual, sin transparencia).
OTROS = {'title_borde.bmp': 'titulo-seccion', 'up.bmp': 'flecha-arriba', 'Down.bmp': 'flecha-abajo'}

MAGENTA = (255, 0, 255)


def sin_magenta(img: Image.Image) -> Image.Image:
    img = img.convert('RGBA')
    img.putdata([(r, g, b, 0) if (r, g, b) == MAGENTA else (r, g, b, a) for (r, g, b, a) in list(img.getdata())])
    return img


def main() -> None:
    origen = Path(sys.argv[1]) if len(sys.argv) > 1 else ORIGEN_DEFAULT
    DESTINO.mkdir(parents=True, exist_ok=True)
    for src, dst in ICONOS.items():
        sin_magenta(Image.open(origen / src)).save(DESTINO / f'{dst}.png', optimize=True)
    tira = Image.open(origen / 'todas.bmp')
    for i, dst in TIRA.items():
        sin_magenta(tira.crop((i * 32, 0, i * 32 + 32, 32))).save(DESTINO / f'{dst}.png', optimize=True)
    for src, dst in OTROS.items():
        Image.open(origen / src).convert('RGB').save(DESTINO / f'{dst}.png', optimize=True)
    print(f'{len(ICONOS) + len(TIRA) + len(OTROS)} imagenes -> {DESTINO}')


if __name__ == '__main__':
    main()
