# Extrae los íconos originales del visor de cartas del Melipal (Easy Navigator)
# desde Navigator.exe y los guarda como PNG en public/img/carta/.
#
# Los íconos no están sueltos: viven dentro del .exe (Delphi), en los
# TImageList del formulario principal (32x32, en versiones activo / inactivo /
# marcado) y como recursos bitmap de 80x40 (dos estados de 40x40 lado a lado).
#
# Se corre una sola vez. Requiere Pillow y pefile.
#   python scripts/importar-navigator-melipal.py ["<ruta a Navigator.exe>"]

import io
import struct
from collections import Counter
import sys
from pathlib import Path

import pefile
from PIL import Image

EXE_DEFAULT = (
    Path(__file__).resolve().parents[2]
    / 'SIMULADOR 2011' / 'SIMULADOR FULL' / '_Release Melipal Full Abril 2011' / 'Navigator' / 'Navigator.exe'
)
DESTINO = Path(__file__).resolve().parents[1] / 'public' / 'img' / 'carta'

# Orden de los íconos en los TImageList de la barra de herramientas.
ICONOS = ['abrir', 'relative', 'true', 'chart', 'zoom-mas', 'zoom-menos', 'puntero',
          'medir', 'anillos', 'opciones', 'ayuda', 'overlay', 'arpa']
LISTAS = {'IActivos': 'activo', 'IInactivos': 'inactivo', 'IMarcados': 'marcado'}
# Botones de 80x40 de las pestañas Trace y GPS: mitad izquierda habilitado, derecha deshabilitado.
BOTONES = {'B_MARCAR': 'marcar', 'B_DESMARCAR': 'desmarcar', 'B_CLEARTRACE': 'borrar-traza',
           'B_CONECTAR': 'conectar', 'B_DESCONECTAR': 'desconectar'}


def recursos(pe, tipo):
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if t.id != pefile.RESOURCE_TYPE[tipo]:
            continue
        for r in t.directory.entries:
            d = r.directory.entries[0].data.struct
            yield str(r.name), pe.get_data(d.OffsetToData, d.Size)


def bmp_desde_dib(dib: bytes) -> Image.Image:
    # Un RT_BITMAP no trae el BITMAPFILEHEADER: se lo agregamos.
    hdr = struct.unpack('<I', dib[:4])[0]
    bits = struct.unpack('<H', dib[14:16])[0]
    ncol = struct.unpack('<I', dib[32:36])[0] or (1 << bits if bits <= 8 else 0)
    cab = b'BM' + struct.pack('<IHHI', 14 + len(dib), 0, 0, 14 + hdr + ncol * 4)
    return Image.open(io.BytesIO(cab + dib)).convert('RGBA')


def transparente(img: Image.Image) -> Image.Image:
    # El fondo de estos glyphs es un color plano (cian, gris…) que se usa como
    # transparente. Tomamos el color más frecuente del borde de la imagen: el
    # píxel de la esquina (lo que usa Delphi) a veces cae sobre el dibujo.
    w, h = img.size
    borde = [img.getpixel((x, y)) for x in range(w) for y in (0, h - 1)]
    borde += [img.getpixel((x, y)) for y in range(h) for x in (0, w - 1)]
    clave = Counter(borde).most_common(1)[0][0]
    img.putdata([(r, g, b, 0) if (r, g, b, a) == clave else (r, g, b, a) for (r, g, b, a) in list(img.getdata())])
    return img


def lista_de_imagenes(form: bytes, nombre: str) -> list[Image.Image]:
    # Propiedad "Bitmap" (vaBinary) del TImageList: cabecera de 28 bytes con
    # cantidad y tamaño, seguida de un BMP color y un BMP máscara en grilla.
    # Buscamos la definición del componente (clase + nombre), no las
    # referencias desde las barras de herramientas (Images = IActivos).
    i = form.find(b'\x0aTImageList' + bytes([len(nombre)]) + nombre.encode())
    j = form.find(b'\x06Bitmap\x0a', i) + len(b'\x06Bitmap\x0a')
    largo = struct.unpack('<i', form[j:j + 4])[0]
    datos = form[j + 4:j + 4 + largo]
    n, _, _, cx, cy = struct.unpack('<HHHHH', datos[4:14])
    bms = [k for k in range(len(datos)) if datos[k:k + 2] == b'BM']
    color = Image.open(io.BytesIO(datos[bms[0]:bms[1]])).convert('RGBA')
    mascara = Image.open(io.BytesIO(datos[bms[1]:])).convert('L')
    columnas = color.width // cx
    salida = []
    for k in range(n):
        x, y = (k % columnas) * cx, (k // columnas) * cy
        img = color.crop((x, y, x + cx, y + cy))
        img.putalpha(mascara.crop((x, y, x + cx, y + cy)).point(lambda v: 0 if v > 128 else 255))
        salida.append(img)
    return salida


def main() -> None:
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else EXE_DEFAULT
    pe = pefile.PE(str(exe))
    DESTINO.mkdir(parents=True, exist_ok=True)
    form = dict(recursos(pe, 'RT_RCDATA'))['TFVISOR']
    for lista, estado in LISTAS.items():
        for nombre, img in zip(ICONOS, lista_de_imagenes(form, lista)):
            img.save(DESTINO / f'tb-{nombre}-{estado}.png', optimize=True)
    for recurso, dib in recursos(pe, 'RT_BITMAP'):
        if recurso in BOTONES:
            img = bmp_desde_dib(dib)
            mitad = img.width // 2
            transparente(img.crop((0, 0, mitad, img.height))).save(DESTINO / f'{BOTONES[recurso]}.png', optimize=True)
            transparente(img.crop((mitad, 0, img.width, img.height))).save(
                DESTINO / f'{BOTONES[recurso]}-inactivo.png', optimize=True)
    print(f'iconos -> {DESTINO}')


if __name__ == '__main__':
    main()
