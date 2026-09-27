// Voz por VHF, "push-to-talk" como en el Melipal: se habla mientras se
// mantiene apretado TRANSMIT. El micrófono se baja a 8 kHz y se codifica en
// µ-law (8 kB/s, calidad de radio) y viaja por el mismo Socket.IO de la
// sesión. El servidor solo reenvía; cada puesto decide si escucha según el
// canal que tiene sintonizado.

import type { Socket } from 'socket.io-client';
import type { CanalVHF, VozFinDTO, VozInicioDTO, VozPaqueteDTO } from '../../shared/types.js';

const TASA_HZ = 8000;
// Colchón contra el jitter de la red: el audio suena 0,2 s después de llegar.
const RETARDO_S = 0.2;
// Nadie deja la radio "trabada" hablando más de un minuto.
const MAX_TX_MS = 60_000;
// El micrófono queda abierto un rato después de hablar para no cortar el
// principio de la próxima transmisión; después se libera.
const LIBERAR_MIC_MS = 60_000;
const MU = 255;

export interface OpcionesVoz {
  /** Si este puesto escucha ese canal ahora (encendido, sintonizado, etc.). */
  escuchar(canal: CanalVHF): boolean;
  /** Alguien empezó o terminó de hablar en un canal que se escucha. */
  alRecibir?(e: { canal: CanalVHF; nombre: string; activo: boolean }): void;
  /** Este puesto empezó o dejó de transmitir (también por el corte de 60 s). */
  alTransmitir?(activo: boolean): void;
}

interface Emisor {
  canal: CanalVHF;
  nombre: string;
  proximo: number;
  sonando: boolean;
}

export class VozVHF {
  private ctx: AudioContext | null = null;
  private salida: GainNode | null = null;
  private stream: MediaStream | null = null;
  private fuente: MediaStreamAudioSourceNode | null = null;
  private procesador: ScriptProcessorNode | null = null;
  private pedidoTx = false;
  private transmitiendo = false;
  private corteTx: number | undefined;
  private liberarMic: number | undefined;
  private emisores = new Map<string, Emisor>();
  // Estado del diezmado a 8 kHz entre bloques de audio.
  private suma = 0;
  private cuenta = 0;
  private fase = 0;
  private volumen = 0.8;
  private mudo = false;

  constructor(private socket: Socket, private opciones: OpcionesVoz) {
    socket.on('vhf:voz-inicio', (p: VozInicioDTO) => {
      this.emisores.set(p.id, { canal: p.canal, nombre: p.nombre, proximo: 0, sonando: false });
    });
    socket.on('vhf:voz', (p: VozPaqueteDTO) => this.recibir(p));
    socket.on('vhf:voz-fin', (p: VozFinDTO) => {
      const e = this.emisores.get(p.id);
      this.emisores.delete(p.id);
      if (!e?.sonando) return;
      this.colaSquelch(e.proximo);
      this.opciones.alRecibir?.({ canal: e.canal, nombre: e.nombre, activo: false });
    });
    // Los navegadores no dejan sonar audio hasta que el usuario toca algo.
    const desbloquear = () => void this.audio();
    window.addEventListener('pointerdown', desbloquear, { once: true });
    window.addEventListener('keydown', desbloquear, { once: true });
  }

  get volumenActual(): number { return this.volumen; }
  get estaMudo(): boolean { return this.mudo; }

  setVolumen(v: number): void {
    this.volumen = Math.max(0, Math.min(1, v));
    this.aplicarGanancia();
  }

  setMudo(m: boolean): void {
    this.mudo = m;
    this.aplicarGanancia();
  }

  /** Empieza a transmitir. Devuelve false si no hay micrófono o permiso. */
  async iniciarTx(canal: CanalVHF): Promise<boolean> {
    if (this.pedidoTx) return true;
    this.pedidoTx = true;
    const ctx = await this.audio();
    if (!ctx || !navigator.mediaDevices?.getUserMedia) {
      this.pedidoTx = false;
      return false;
    }
    window.clearTimeout(this.liberarMic);
    if (!this.stream) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        this.pedidoTx = false;
        return false;
      }
    }
    // Si soltó el botón mientras el navegador pedía permiso, no sale nada.
    if (!this.pedidoTx) {
      this.programarLiberarMic();
      return true;
    }

    this.suma = 0;
    this.cuenta = 0;
    this.fase = 0;
    const razon = ctx.sampleRate / TASA_HZ;
    this.fuente = ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor está deprecado pero anda en todos los navegadores sin
    // archivos aparte, y a 8 kHz sobra.
    this.procesador = ctx.createScriptProcessor(2048, 1, 1);
    this.procesador.onaudioprocess = (ev) => {
      const entrada = ev.inputBuffer.getChannelData(0);
      const salida: number[] = [];
      for (let i = 0; i < entrada.length; i++) {
        this.suma += entrada[i]!;
        this.cuenta++;
        this.fase++;
        if (this.fase >= razon) {
          salida.push(codificarMuLaw(this.suma / this.cuenta));
          this.suma = 0;
          this.cuenta = 0;
          this.fase -= razon;
        }
      }
      if (salida.length > 0) this.socket.emit('vhf:voz', new Uint8Array(salida).buffer);
    };
    // El procesador solo corre si está conectado a la salida: va en silencio.
    const silencio = ctx.createGain();
    silencio.gain.value = 0;
    this.fuente.connect(this.procesador);
    this.procesador.connect(silencio);
    silencio.connect(ctx.destination);

    this.socket.emit('vhf:voz-inicio', { canal });
    this.transmitiendo = true;
    this.corteTx = window.setTimeout(() => this.detenerTx(), MAX_TX_MS);
    this.opciones.alTransmitir?.(true);
    return true;
  }

  detenerTx(): void {
    this.pedidoTx = false;
    if (!this.transmitiendo) return;
    this.transmitiendo = false;
    window.clearTimeout(this.corteTx);
    this.procesador?.disconnect();
    this.fuente?.disconnect();
    if (this.procesador) this.procesador.onaudioprocess = null;
    this.procesador = null;
    this.fuente = null;
    this.socket.emit('vhf:voz-fin');
    this.programarLiberarMic();
    this.opciones.alTransmitir?.(false);
  }

  destruir(): void {
    this.detenerTx();
    window.clearTimeout(this.liberarMic);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  private recibir(p: VozPaqueteDTO): void {
    const e = this.emisores.get(p.id);
    const ctx = this.ctx;
    if (!e || !ctx || !this.salida || ctx.state !== 'running') return;
    // Se vuelve a preguntar en cada paquete: el alumno puede cambiar de
    // canal o apagar la radio en medio de una transmisión.
    if (!this.opciones.escuchar(e.canal)) {
      if (e.sonando) {
        e.sonando = false;
        this.opciones.alRecibir?.({ canal: e.canal, nombre: e.nombre, activo: false });
      }
      return;
    }
    if (!e.sonando) {
      e.sonando = true;
      this.opciones.alRecibir?.({ canal: e.canal, nombre: e.nombre, activo: true });
    }
    const bytes = new Uint8Array(p.pcm);
    if (bytes.length === 0) return;
    const buffer = ctx.createBuffer(1, bytes.length, TASA_HZ);
    const datos = buffer.getChannelData(0);
    for (let i = 0; i < bytes.length; i++) datos[i] = decodificarMuLaw(bytes[i]!);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.salida);
    // Si la red se atrasó y la cola quedó vacía, se vuelve a dejar colchón.
    const t = Math.max(e.proximo, ctx.currentTime + (e.proximo < ctx.currentTime ? RETARDO_S : 0));
    src.start(t);
    e.proximo = t + buffer.duration;
  }

  // El "shhh" corto del squelch al terminar una transmisión.
  private colaSquelch(desde: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.salida || ctx.state !== 'running') return;
    const n = Math.round(TASA_HZ * 0.12);
    const buffer = ctx.createBuffer(1, n, TASA_HZ);
    const datos = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) datos[i] = (Math.random() * 2 - 1) * 0.25 * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.salida);
    src.start(Math.max(desde, ctx.currentTime));
  }

  private async audio(): Promise<AudioContext | null> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      // Banda de voz de una radio (300 a 3000 Hz).
      const pasaAltos = this.ctx.createBiquadFilter();
      pasaAltos.type = 'highpass';
      pasaAltos.frequency.value = 300;
      const pasaBajos = this.ctx.createBiquadFilter();
      pasaBajos.type = 'lowpass';
      pasaBajos.frequency.value = 3000;
      this.salida = this.ctx.createGain();
      this.salida.connect(pasaAltos);
      pasaAltos.connect(pasaBajos);
      pasaBajos.connect(this.ctx.destination);
      this.aplicarGanancia();
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* sin gesto del usuario todavía */ }
    }
    return this.ctx;
  }

  private aplicarGanancia(): void {
    if (this.salida) this.salida.gain.value = this.mudo ? 0 : this.volumen * 1.5;
  }

  private programarLiberarMic(): void {
    window.clearTimeout(this.liberarMic);
    this.liberarMic = window.setTimeout(() => {
      if (this.transmitiendo) return;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }, LIBERAR_MIC_MS);
  }
}

/**
 * Cablea un botón "mantener apretado para hablar" y, opcionalmente, la barra
 * espaciadora (salvo cuando se está escribiendo en un campo).
 */
export function conectarPTT(
  boton: HTMLElement,
  iniciar: () => void,
  detener: () => void,
  conEspacio = false,
): void {
  boton.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    boton.setPointerCapture(e.pointerId);
    iniciar();
    e.preventDefault();
  });
  boton.addEventListener('pointerup', detener);
  boton.addEventListener('pointercancel', detener);
  boton.addEventListener('lostpointercapture', detener);
  boton.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', detener);
  if (!conEspacio) return;
  const escribiendo = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || escribiendo(e.target)) return;
    e.preventDefault();
    if (!e.repeat) iniciar();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || escribiendo(e.target)) return;
    e.preventDefault();
    detener();
  });
}

function codificarMuLaw(x: number): number {
  const s = Math.max(-1, Math.min(1, x));
  const y = Math.log1p(MU * Math.abs(s)) / Math.log1p(MU);
  return (s < 0 ? 0x80 : 0) | Math.round(y * 127);
}

function decodificarMuLaw(b: number): number {
  const s = (Math.pow(1 + MU, (b & 0x7f) / 127) - 1) / MU;
  return b & 0x80 ? -s : s;
}
