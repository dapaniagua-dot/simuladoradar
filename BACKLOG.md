# Backlog — próximas mejoras

Lista de mejoras agendadas que no entran en el MVP actual pero están planificadas. Ordenadas por prioridad.

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

*Última actualización: 2026-04-28.*
