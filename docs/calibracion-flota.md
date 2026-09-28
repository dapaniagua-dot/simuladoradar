# Calibración de la flota contra el Melipal

La versión web tiene los seis buques de río de la flota del Melipal que se usan en la ENF (del `fleet.cfg`). Su comportamiento está **escalado** a partir del Meko 140 que usábamos en las primeras versiones, según la eslora, el desplazamiento y la velocidad de cada uno, y es provisorio hasta medirlos en el Melipal.

Para que cada buque maniobre como en el Melipal hacen falta unas pocas mediciones en el simulador de escritorio. Con estos números se ajustan cinco valores por buque: la arrancada, la parada, el giro, el giro con máquinas opuestas y la velocidad del timón.

## Qué buques medir

Los seis de la ENF, en este orden (el primero es el que usa el simulador por defecto):

1. Balizador
2. Remolcador
3. Ganguil
4. Halcón del Sur
5. Antares
6. Cau Cau

## Pruebas por buque

Todas en **aguas profundas**, **sin viento ni corriente**, las dos máquinas iguales salvo donde se indica. Anotar los tiempos con cronómetro y leer velocidad, rumbo y posición en la consola y el GPS.

| # | Prueba | Cómo se hace | Qué anotar |
|---|---|---|---|
| 1 | **Velocidades del telégrafo** | Poner cada posición (Dead Slow, Slow, Half, Manoeuvring y Full, avante y atrás) y esperar a que la velocidad se estabilice | La velocidad final en cada posición |
| 2 | **Arrancada** | Desde parado, Full Ahead | El tiempo hasta la mitad de la velocidad máxima y hasta el 90 % |
| 3 | **Parada libre** | Navegando estable a Full Ahead, poner Stop | La velocidad al minuto, a los 3 y a los 5 minutos |
| 4 | **Parada de emergencia** | Navegando estable a Full Ahead, poner Full Astern | El tiempo hasta velocidad 0 y la distancia recorrida (del GPS) |
| 5 | **Curva de giro** | Navegando estable a Full Ahead, timón 35° a una banda | La tasa de giro estabilizada (°/min) y la velocidad durante el giro. Si se puede, el diámetro del círculo (posiciones del GPS a los 0°, 90°, 180° y 270° de caída) |
| 6 | **Timón de banda a banda** | Con el buque parado, de 35° a babor a 35° a estribor | El tiempo que tarda |
| 7 | **Máquinas opuestas** (solo los de dos máquinas) | Parado, una máquina Full Ahead y la otra Full Astern, timón a la vía | La tasa de giro estabilizada (°/min) |

## Cómo anotarlo

Alcanza con una planilla con una fila por buque y una columna por medición. Si en alguna prueba el Melipal hace algo raro (por ejemplo, que no se estabilice), anotarlo también.

## Qué se hace después

Con esos datos se cargan los valores medidos en `src/server/simulacion/buques.ts`, el buque deja de figurar con `*` y se repite la misma prueba en la versión web para comparar.
