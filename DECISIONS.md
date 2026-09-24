# Decisiones técnicas — Simulador de Radar web

Este archivo registra las decisiones técnicas tomadas y por qué. **Cada decisión es revisable y desafiable**: si Diego no está de acuerdo, se discute y se cambia. Las decisiones aquí están **ordenadas por impacto** (las más caras de revertir primero).

> **Contexto**: el 2026-04-27, Diego entró en una reunión y autorizó a Claude Code a tomar decisiones técnicas razonables y avanzar con el MVP 0 sin esperar confirmación, dejando todo documentado para revisión.

---

## D1. Node.js + TypeScript en server y client

**Decidido:** Node.js (≥ 20) con TypeScript en backend y frontend.

**Alternativas descartadas:**
- Python + FastAPI: requeriría mantener dos lenguajes. La traducción Pascal→TS de los `.pas` de Melipal es más directa que Pascal→Python (sintaxis y semántica más cercanas).
- JavaScript puro sin TS: sin tipos, los formatos de Melipal (`fleet.cfg`, `.map`, `.scn`) son complejos y perderíamos mucho con bugs de tipo.
- Bun en lugar de Node: más rápido pero menos maduro en Windows y Railway lo soporta peor.

**Por qué:** mismo lenguaje en todo el stack, ecosistema enorme, soporte nativo de Railway, y el motor del radar (que va a ser código pesado) se beneficia del type-checking estricto.

---

## D2. Sin framework frontend pesado (vanilla TS + Canvas)

**Decidido:** HTML5 + TypeScript + Canvas 2D directo, sin React/Vue/Angular/Svelte. Se usa **Vite** como bundler y dev server.

**Alternativas descartadas:**
- React + Three.js: agrega ~100 KB de runtime y abstracción que no aporta al PPI del radar (que es Canvas puro). Más overhead en CPU para PCs modestas.
- Svelte: ligero y razonable, pero mismo argumento — el simulador es 80% pintura sobre Canvas, no UI declarativa con muchos componentes.

**Por qué:** el PPI del radar se renderiza directamente con Canvas. Las tres pantallas (Mando, Radar, Carta) son cada una una página HTML simple con su `<canvas>` y su TS. Multi-página > SPA para este caso. Si después necesitamos componentes complejos, agregar React es trivial.

**Riesgo aceptado:** si la complejidad UI crece mucho (formularios anidados de configuración del Assessor, etc.), tener un framework va a ser cómodo. Lo evaluamos cuando llegue.

---

## D3. PostgreSQL (no SQLite)

**Decidido:** Postgres como única opción de BD.

**Alternativas descartadas:**
- SQLite para dev + Postgres para prod: Drizzle soporta ambos pero el schema necesita cuidados. Confunde más de lo que ayuda.
- MongoDB: el dominio es muy relacional (usuarios → sesiones → participaciones → replays). NoSQL no aporta acá.

**Por qué:** un solo dialect para dev y prod simplifica todo. Alternativas para no instalar nada local: **Neon** (recomendado, serverless gratis) o **Railway** (también gratis al principio). Documentado en el README.

---

## D4. Drizzle ORM

**Decidido:** [Drizzle](https://orm.drizzle.team) como ORM/query builder.

**Alternativas descartadas:**
- Prisma: más maduro, pero pesa ~30 MB de binario, su CLI es lenta, y el cliente generado no es tree-shakeable. Para Railway free tier importa.
- Driver crudo `pg` con SQL a mano: sin tipos en queries, propenso a errores en una codebase grande.
- Sequelize / TypeORM: APIs más viejas, peor type safety.

**Por qué:** Drizzle es ligero, tiene tipos derivados del schema sin generación de código, y soporta migraciones con `drizzle-kit push` (rapidísimo en dev).

---

## D5. Sesiones server-side con cookie HTTPOnly (no JWT)

**Decidido:** `express-session` + `connect-pg-simple` (sesiones persistidas en Postgres).

**Alternativas descartadas:**
- JWT: más simple para escalar horizontalmente, pero **no se puede invalidar** sin lista negra. Para una app educativa con sesiones cortas y necesidad de "echar" a un alumno mid-clase, sesiones server-side son mejores.
- Cookie firmada solo (sin store): no podemos invalidar.
- Auth0/Clerk: agregamos dependencia externa y costo. No vale la pena para 5 alumnos por clase.

**Por qué:** baja complejidad, control total, escala sobrado para el tamaño del producto. Y como las contraseñas las asigna el admin (no auto-registro), todo el flujo de auth queda muy simple.

---

## D6. bcryptjs (no bcrypt nativo)

**Decidido:** `bcryptjs` (puro JS) en vez de `bcrypt` (bindings nativos C++).

**Por qué:** evita problemas de compilación de binarios nativos en Windows / Linux con node-gyp. La diferencia de performance es despreciable para los volúmenes esperados (< 100 logins/minuto).

---

## D7. Socket.IO (no WebSocket crudo)

**Decidido:** Socket.IO para tiempo real entre instructor y alumnos.

**Alternativas descartadas:**
- `ws` crudo: sin reconexión automática, sin rooms, sin acks. Hay que reimplementarlo.
- Server-Sent Events: solo unidireccional, no sirve para comandos del alumno al server.

**Por qué:** las features que da out-of-the-box (rooms, acks, reconexión, fallback) son exactamente las que necesitamos para sesiones multi-usuario. El overhead vs `ws` crudo es minúsculo.

---

## D8. Layout multi-ventana del alumno con BroadcastChannel API

> **Reemplazada por D13** (2026-09-23): el alumno cursa desde casa con un solo monitor.

**Decidido (a implementar en MVP 4):** las 3 vistas del alumno (Radar, Mando, Carta) se sirven como 3 páginas HTML separadas. Una de ellas es la "principal" (Radar). Las otras dos se abren con `window.open()` y se sincronizan con la principal por **BroadcastChannel API** + cada una mantiene su propio Socket.IO al server.

**Por qué:** el usuario puede arrastrar las ventanas a monitores distintos. Si tiene un solo monitor, las apila como tabs del browser. Cumple exactamente lo que pidió Diego (Opción 1C).

**Alternativa considerada:** un solo HTML con grid CSS de 3 paneles. Lo descarto porque pierde la flexibilidad de poder enviar una vista a otro monitor.

---

## D9. Estructura monorepo simple (sin workspaces)

**Decidido:** un solo `package.json` raíz con `src/server`, `src/client`, `src/shared` adentro.

**Alternativa descartada:** workspaces npm o pnpm con paquetes separados. Overhead innecesario para el tamaño del proyecto.

---

## D10. Despliegue en Railway

**Decidido:** Railway como plataforma de deploy.

**Por qué:** ya estaba previsto en `CLAUDE.md`, ofrece Postgres + app Node + dominio TLS automático, free tier alcanza para empezar, deploy automático desde GitHub. Si la ENF pide otro hosting después, migrar es directo (todo el stack es estándar).

---

## D11. Sin tests aún

**Decidido:** no agregamos framework de testing en MVP 0. Cuando lleguemos a MVP 2/3 (lógica del simulador), agregamos `vitest`.

**Por qué:** el MVP 0 es 90% glue code (auth, BD). Lo crítico para testear va a ser la lógica del radar y la física del buque, que recién aparece en MVP 2-3. Agregar la infra ahora sin tener qué testear es prematuro.

---

## D12. Idioma del código y commits: español rioplatense

**Decidido:** identificadores de dominio (`embarcacion`, `derrota`, `eco`, `escenario`) en español; términos técnicos universales (`socket`, `render`, `auth`, `Router`) en inglés. Commits en español.

**Por qué:** alineado con `CLAUDE.md` y con los `.pas` originales que ya usan español. Mantiene la trazabilidad del dominio náutico.

---

## D13. Aula del alumno en una sola pantalla con vista principal seleccionable

**Decidido (2026-09-23, pedido de Diego):** Radar, Consola y Carta conviven en una sola pantalla. Una vista ocupa la columna grande de la izquierda (55 %) y las otras dos se apilan a la derecha (45 %). El alumno elige cuál va grande; al entrar siempre arranca el Radar.

**Cómo:** el radar es la misma `radar.html` embebida en un `<iframe>` con `?embebido=1` (oculta su barra superior). Cambiar de vista solo cambia el `grid-area` de cada panel, sin mover nodos del DOM, así el iframe no se recarga ni pierde su socket.

**Por qué:** el alumno cursa desde casa con un solo monitor (reemplaza D8). La proporción 55/45 la eligió Diego probando: con 65/35 la consola quedaba muy apretada.

---

## D14. Consola de mando con los gráficos originales del Melipal

**Decidido (2026-09-23, pedido de Diego):** la consola se arma con los BMP originales del módulo Comando (release 2011), convertidos a PNG en `public/img/consola/` por `scripts/importar-consola-melipal.py`, y con la fuente 7 segmentos original (`public/fonts/7segmentos.ttf`). Los displays, botones, palancas y agujas son controles web encima de esas imágenes, en coordenadas medidas sobre los gráficos.

La consola es un "escenario" fijo de 1025×785 px (el tamaño de la pantalla original) que se escala con `transform: scale()` al ancho del panel.

**Por qué:** la transferencia al simulador físico de la ENF es un objetivo central; con los gráficos originales el cadete ve exactamente lo mismo. La ENF tiene autorización de INVAP para usar y modificar el software.

**Cambia el acuerdo previo** de que el diseño visual lo hacía Diego después con Claude Design: para la consola no hace falta diseñar nada, se usa el original. El GPS no tiene gráfico original: se dibujó una pantalla LCD sobre la chapa vacía.

---

## D15. Telégrafo doble (dos máquinas) y posición MANOEUVRING

**Decidido (2026-09-23, pedido de Diego):** cada buque tiene dos palancas de telégrafo (babor y estribor) con las 10 posiciones del Melipal, incluida **MAN** (Manoeuvring) entre Full y Half Ahead.

- **MAN = 320 RPM / 22 kn:** el `fleet.cfg` del M140 trae 9 valores de RPM (400, 320, 250, 150, 60, −60, −150, −250, −400); 320 es el que queda entre Full y Half. Con velocidad ∝ RPM: 27.5 × 320/400 = 22 kn.
- **Velocidad:** se promedian las **RPM** de las dos máquinas y se busca la velocidad en la tabla RPM→velocidad. No se promedian velocidades porque la tabla es asimétrica (atrás el M140 anda a −4.4 kn máx): promediando velocidades, una avante y otra atrás a full daba 11.5 kn de avance; promediando RPM da 0 kn, como corresponde.
- **Giro por empuje diferencial:** (RPM babor − RPM estribor) / (2 × RPM máx) × 0.25 °/s, que se establece con una constante de tiempo de 10 s. Máquinas opuestas a full ⇒ ~15 °/min, aun con el buque parado. Se suma al giro por timón.

**Provisorio:** el 0.25 °/s y los 10 s no salen del `fleet.cfg`; se ajustan en la iteración de calibración física (BACKLOG) comparando con el Melipal real.

---

## D16. Radar con el aspecto del radar del Melipal

**Decidido (2026-09-23, pedido de Diego):** la pantalla del radar replica la del `SRadar.exe` del Melipal: PPI azul oscuro con ecos amarillos, anillos blancos, bisel negro con escala de marcaciones, textos en las esquinas (HEADING / SPEED / RANGE / RINGS / MARKER INFO / OWN SHIP), controles GAIN/TUNE/SEA/RAIN y el panel derecho de 260 px con los mismos botones y pestañas.

**Cómo:** a diferencia de la consola (D14), el radar original **no tiene gráficos**: son controles Delphi estándar (se verificó extrayendo el formulario `TFPRINCIPAL` del .exe). Se reprodujo con CSS/canvas tomando como referencia la captura del manual (`docs/referencia/melipal-radar.png`), con colores medidos sobre ella.

**Qué funciona:** RANGE ±, NORTH/COURSE/HEAD UP, EBL 1-2 y VRM 1-2 (arrastrando sobre el PPI o con −/+), RINGS, HEAD/STERN MARKER, BEARING SCALE, SWEEP LINE, NIGHT COLORS, ARPA (adquisición y cese manual, vector verdadero/relativo, longitud de vector, límites de CPA/TCPA, datos de 2 blancos), alarmas COLLISION WARNING / NEW TARGET / LOST TARGET, STAND BY / TRANSMIT, GAIN, TUNE, SEA y AUTO CLUTTER (hay clutter de mar simulado alrededor del buque propio).

**Qué se ve pero no hace nada todavía:** TRUE MOTION, CENTRE, OWN HISTORY, RADAR ONLY, AUTO ACQUIRE, GROUND STAB, INTERF REJECTION, RAIN, y las pestañas Navigation, Trial Maneuver, Track Zone, Map, Parallel Index y Reference Position.

---

## D17. Carta con el aspecto del Easy Navigator y recorrido (trace) del buque

**Decidido (2026-09-24, pedido de Diego):** la vista Carta replica el visor de cartas del Melipal (Easy Navigator, manual sección 4.3): barra de herramientas con los **íconos originales** (extraídos de `Navigator.exe` por `scripts/importar-navigator-melipal.py` a `public/img/carta/`), pestañas GPS / Trace, barra de estado y el buque amarillo con vector de rumbo.

**Recorrido (trace):** lo guarda el **server**, un punto cada 5 s por buque (hasta 4 h), y lo manda al conectarse (`traza:snapshot`) y a medida que avanza (`traza:punto`). Así no se pierde al recargar la página y queda disponible para el Replay y la vista del profesor. El alumno recibe solo su propio recorrido.

En la carta, el alumno elige cada cuánto dibujar un punto (5 s a 5 min), puede ocultar la línea, pausar el muestreo ("Sample") o borrarla, y agregar **marcas** numeradas con nombre y descripción (botón Mark; doble click para verlas). Borrar, pausar y las marcas se guardan en el navegador del alumno (localStorage), no en el server: son anotaciones personales, como en el original.

**Otras funciones:** zoom (botones y rueda), modos Relative Motion (buque al centro), True Motion (carta fija, se recentra en el borde) y Chart (mover la carta; arrastrar la carta pasa a este modo), herramienta de medir distancia y marcación, anillos de distancia alrededor del buque.

**Cambio respecto a antes:** la carta ya **no muestra los otros buques**. El Easy Navigator es un plotter conectado al GPS propio: los demás buques se detectan con el radar, que es justamente lo que se entrena.

**No disponible todavía:** abrir carta (la elige el profesor), overlay de radar y ARPA sobre la carta, ventana de preferencias.

---

## D18. Consola del instructor con el aspecto del Melipal Instructor Module

**Decidido (2026-09-24, pedido de Diego):** la vista del profesor (`sesion.html`) replica el Instructor Module del Melipal (`docs/referencia/melipal-instructor.png`): barra de herramientas con los íconos originales (`public/img/instructor/`, importados por `scripts/importar-instructor-melipal.py`), panel izquierdo con secciones desplegables (General, Exercise, Own Ships, VHF), carta al centro, matriz CPA-TCPA abajo y barra de estado.

- **Simulación:** Play abre la sesión (si está preparada) o la reanuda; Pausa; Stop la termina.
- **Carta:** todos los buques en rojo con etiqueta amarilla `OS-01`, vector (largo en minutos) y recorrido; click en un buque lo toma como **referencia** (el cursor mide marcación y distancia desde él, y los anillos se dibujan a su alrededor). Antes de abrir se ven las posiciones iniciales y se ubica cada buque como antes (click + arrastrar el rumbo).
- **Own Ships:** datos en vivo de cada alumno (rumbo, velocidad, telégrafos, timón, autopiloto).
- **Matriz CPA-TCPA:** marcación, distancia, CPA y TCPA entre cada par de buques, suponiendo rumbo y velocidad constantes.

**Código compartido:** la carta del alumno (Easy Navigator) y la del instructor heredan de `src/client/carta/vista-carta.ts` (zoom, desplazamiento, coordenadas, medición, casco, vector, recorrido, anillos).

**Etapas siguientes (pedidas por Diego):** viento y corriente, ver el radar/consola de un alumno, blancos del profesor (Directed Targets y Targets con waypoints).

---

## D19. Show Radar / Show Console del instructor

**Decidido (2026-09-24, pedido de Diego):** como en el Melipal (pestaña Radar de cada Own Ship y la PC de radar del instructor), el profesor abre en vivo el **radar** o el **aula** de cualquier alumno desde su fila en Own Ships.

- **Acceso:** `/radar.html` y `/aula.html` con `?observar=N`. El endpoint `/api/aula/:id?observar=N` solo lo acepta el profesor dueño de la sesión o un admin, y con la sesión abierta.
- **Solo lectura:** los controles se ven pero no se pueden tocar; además el server ya ignora los comandos que no vienen del alumno.
- **Radar igual al del alumno:** el radar del alumno publica su configuración (escala, modo, EBL/VRM, controles, blancos ARPA) por socket (`radar:estado`, al cambiar y cada 2 s) y el observador la copia.
- **Presencia:** el server cuenta qué pantallas tiene abiertas cada alumno (aula / radar) y avisa al instructor; la sección Connections muestra "Seeing Radar from Post" y el registro de eventos.

**Pendiente (3b):** fallas inducidas (GPS, giro, corredera, autopiloto, máquina, radar, sector ciego, ecos falsos, perder blancos ARPA) y tomar el control de un buque.

---

## Cosas que NO decidí (pendientes de Diego)

1. **Cuenta de Neon vs Railway para Postgres en dev**: dejé documentadas ambas opciones. Diego elige cuando vuelva.
2. **Hosting del repo**: ya está en GitHub público en `dapaniagua-dot/simuladoradar`. ¿Mantener público o pasarlo a privado? Si tiene credenciales/datos sensibles más adelante, privado es más seguro.
3. **Push del primer commit**: hice el commit local, **NO pusheé**. Diego pushea cuando vuelva con sus credenciales.
4. **Email del admin inicial**: dejé `admin@enf.local` por defecto, pero Diego puede sobreescribirlo con la variable `ADMIN_EMAIL` antes de correr `npm run seed`.

---

*Última actualización: 2026-09-23.*
