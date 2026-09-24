# Backlog — próximas mejoras

Lista de mejoras agendadas que no entran en el MVP actual pero están planificadas. Ordenadas por prioridad.

---

## ⏭️ Próximos pasos (acordados el 2026-09-24)

Las tres vistas del alumno y la consola del instructor ya tienen el aspecto del Melipal (DECISIONS D13–D18). La rama `feature/aula-una-pantalla` está en GitHub, pendiente de probar, mergear y desplegar en Railway.

Orden acordado con Diego:

1. **Blancos del profesor**: *Directed Targets* (buques que maneja el profesor: rumbo y velocidad) y *Targets* (siguen una derrota de waypoints con velocidad por tramo, manual sección de Targets). Tienen que aparecer como ecos en el radar (y ser adquiribles por ARPA) y en la carta y la matriz CPA-TCPA del instructor, pero **no** en la carta del alumno (solo GPS propio). Es lo que permite armar situaciones de cruce con cualquier cantidad de alumnos.
2. **Ver el radar / la consola de un alumno** desde el instructor, en vivo y en solo lectura.
3. **Viento y corriente**: el profesor los fija (sección Exercise del instructor, como en el Melipal) y afectan a los buques. Conviene hacerlo junto con la calibración física (más abajo).

---

## 🔇 Cosas que se ven pero todavía no funcionan

Se dejaron a la vista para que las pantallas sean iguales al Melipal:

- **Radar**: TRUE MOTION, CENTRE, OWN HISTORY, RADAR ONLY, AUTO ACQUIRE, GROUND STAB, INTERF REJECTION, RAIN, y las pestañas Navigation, Trial Maneuver, Track Zone, Map, Parallel Index y Reference Position. Los 4 sonidos de alarma del `SRadar.exe` ya están extraídos, falta identificar cuál es cuál.
- **Consola**: PARAM ADJUST, ALARM, LOG FAIL y las teclas del VHF que no son de canal (Lock, SQL, Vol…).
- **Carta del alumno**: abrir carta, overlay de radar, ARPA sobre la carta, preferencias.
- **Instructor**: nuevo/abrir/guardar ejercicio, Replay, lluvias, boyas. Los textos siguen en inglés como en el original (Diego puede pedir pasarlos al castellano).

---

## 🎬 Replay de ejercicios (MVP 6.4 diferido)

**Estado**: agendado el 2026-04-29.
**Origen**: Diego pidió Replay como must-have del MVP 6 desde el principio. Implementarlo bien requiere:

1. **Persistir cada tick** (o un subset cada N ticks) a una tabla `replays`/`replay_frames` en Postgres durante una sesión activa.
2. **Página `/replay.html?sesion=X`** que reproduce los frames con controles de play/pause/seek/speed.
3. **Render** equivalente al aula del alumno + radar PPI sobre los datos grabados.
4. **Limpieza/retención** de replays antiguos para no llenar la BD.

**Avance (2026-09-24)**: el server ya guarda el recorrido de cada buque (un punto cada 5 s, en memoria; ver D17). Para el replay falta persistirlo en la BD junto con el estado completo (telégrafos, timón, rumbo) y la página de reproducción.

**Por qué no es ahora**: trabajo aparte (~1 semana). El MVP funcional para dar un curso ya cierra con VHF + Navtex + DMs (MVP 6.1-6.3). El profesor puede grabar manualmente con OBS o Loom mientras dictamos los primeros cursos, y agregamos replay nativo después.

---

## 📡 Afterglow del PPI con gradiente continuo (cosmético)

**Estado**: agendado el 2026-04-29.
**Origen**: el efecto de barrido del radar usa N capas escalonadas con alphas decrecientes (1.0, 0.95, 0.88… hasta 0.55). Aunque los saltos son pequeños (≤10%), el ojo humano sigue percibiendo una "línea" sutil donde la antena dejó de iluminar.

**Qué hay que hacer**: reemplazar las capas discretas por un gradiente angular continuo. Opciones:
- Pre-renderizar una máscara con `canvas` o `OffscreenCanvas` que tenga el gradiente angular y aplicarla con `globalCompositeOperation = 'source-in'` o similar sobre los ecos en alpha 1.0.
- Usar `CanvasRenderingContext2D.filter` con un `radial-gradient` simulado.
- Investigar si vale usar WebGL para el PPI (resolución del problema de raíz, pero es un refactor grande).

**Por qué no es ahora**: visualmente "es aceptable" según Diego. Pasa a la lista de mejoras estéticas para cuando se haga la pasada de diseño visual con Claude Design.

---

## 🌊 Calibración física náutica (post-MVP 5)

**Estado**: agendado el 2026-04-28.
**Origen**: durante MVP 3, Diego pidió "física exacta". Acordamos arrancar con física simple (Opción C) y volver después con un modelo realista (Opción A) que use los coeficientes del fleet.cfg.

**Qué hay que hacer**:
1. **Parser completo del `fleet.cfg`** que extraiga los ~70 campos por barco (Largo, Masa, Calado, CPF, CPR, W, CH, MDW, CD, MSW, DeltaMax, VelMax, VelMin, CRT, CFT, DeltaT, DeltaU, CAL, CAF, RPM por posición de telégrafo, etc.) y los 22 buques disponibles.
2. **Reemplazar el motor de simulación simple** (que actualmente usa una constante de tiempo lineal y tasa de giro proporcional al timón) por un modelo náutico estándar:
   - **Modelo Nomoto de 1° orden** para la dinámica de giro (o de 2° orden si los coefs lo permiten).
   - **Modelo de propulsión simplificado** que use CPF, CPR, W, masa y calado para calcular fuerza de propulsión a partir de RPM.
   - **Resistencia hidrodinámica** usando CH/MDW (aguas profundas) y CD/MSW (aguas poco profundas) — esto requiere también modelar la batimetría (que viene de las cartas).
   - **Efectos aerodinámicos** con CAL/CAF si modelamos viento.
3. **Permitir al profesor elegir el tipo de buque** que cada alumno comanda al asignarlo a la sesión (campo `tipo_buque` en `participaciones`).
4. **Calibración empírica**: probar con un cadete experimentado del Melipal real y ajustar parámetros del modelo hasta que se sienta similar.

**Por qué no es ahora**:
- Necesitamos el flujo end-to-end andando primero (MVP 3-5) para poder probar la física en su contexto real.
- El parser del fleet.cfg requiere análisis cuidadoso del orden de los ~70 campos; algunos no están documentados en `Fleet.txt`.
- La validación final solo es posible comparando con el Melipal real corriendo en paralelo, lo cual requiere acceso al laboratorio físico de la ENF.

**No-objetivo**: replicar bit-a-bit el motor físico de INVAP. Eso requeriría reverse engineering del `instructor.exe` (Delphi), trabajo de semanas con riesgo alto de no completarse. Apuntamos a "comportamiento realista que use los coefs reales", no "idéntico a Melipal".

---

## 🗺️ Más cartas náuticas

**Estado**: pendiente.
Disponibles en el legacy y por agregar al catálogo: Estrecho de Gibraltar, Bahía del Callao, Approach to Callao, Valparaíso, Estrecho de Magallanes, Golfo Nuevo / Puerto Madryn, BNPB (Puerto Belgrano), Bariloche, Buenos Aires, San Matías, serie A-1 a A-19 (cartas argentinas fluviales).

Cada una requiere: convertir BMP→PNG, copiar `.map` al repo, y agregar entrada al seed.

---

## 🎯 Vista 3D (post-MVP 6)

**Estado**: diferido a v2 desde el primer día del proyecto.
Reescribir el motor `MelipalViewer` (C++ + OpenGL/GLSL) en **Three.js** o **Babylon.js** para WebGL. Cargar los modelos `.3DS` (convertibles a `.gltf`) y los assets del SceneViewer.

Trabajo estimado: 3-5 semanas.

---

## 📝 Assessor — evaluación automática (post-MVP 6)

**Estado**: diferido a v2 desde MVP 0.
Calificador automático con 7 parámetros configurables (CPA, TCPA, Depth Under Keel, Speed Over Water/Ground, Heading, Course Over Ground, Rate of Turn). Genera reporte imprimible con número y duración de violaciones.

Documentado en detalle en el manual original sección 3.7. Trabajo estimado: 2-3 semanas.

---

*Última actualización: 2026-09-24.*
