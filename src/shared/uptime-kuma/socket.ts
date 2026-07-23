import * as v from "valibot";

type SocketListener = (...args: unknown[]) => void;

export interface UptimeKumaSocket {
  connect(): unknown;
  disconnect(): unknown;
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown>;
  off(event: string, listener: SocketListener): unknown;
  once(event: string, listener: SocketListener): unknown;
  timeout(milliseconds: number): UptimeKumaSocket;
}

export interface UptimeKumaWebSocket {
  close(): void;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string): void;
}

export const uptimeKumaWebSocketFactory = {
  create: (url: string): UptimeKumaWebSocket => new WebSocket(url),
};

const EngineOpenSchema = v.object({
  pingInterval: v.number(),
  pingTimeout: v.number(),
  sid: v.string(),
});

const SocketErrorSchema = v.object({ message: v.string() });
const AckFrameMatchSchema = v.tuple([v.string(), v.string(), v.string()]);

type PendingAck = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: number;
};

export const uptimeKumaConnectionError = (value: unknown): Error =>
  value instanceof Error ? value : new Error("Uptime Kuma connection failed.");

const parseJson = (value: string): unknown => JSON.parse(value);

const parseEvent = (value: string): [string, ...unknown[]] => {
  const event: unknown = parseJson(value);
  if (!Array.isArray(event) || typeof event[0] !== "string") {
    throw new Error("Invalid Uptime Kuma Socket.IO event.");
  }
  return event as [string, ...unknown[]];
};

const parseAck = (frame: string): { id: number; value: unknown } => {
  const match = /^43(\d+)(.*)$/.exec(frame);
  if (match === null) throw new Error("Invalid Uptime Kuma acknowledgement.");
  const [, id, data] = v.parse(AckFrameMatchSchema, match);
  const values: unknown = parseJson(data);
  if (!Array.isArray(values)) {
    throw new Error("Invalid Uptime Kuma acknowledgement data.");
  }
  return {
    id: Number(id),
    value: values.length === 1 ? values[0] : values,
  };
};

class KumaSocket implements UptimeKumaSocket {
  #ackId = 0;
  #ackTimeoutMs: number;
  #acks = new Map<number, PendingAck>();
  #connectTimer: number | null = null;
  #connected = false;
  #everConnected = false;
  #closedByClient = false;
  #listeners = new Map<string, Set<SocketListener>>();
  #raw: UptimeKumaWebSocket | null = null;
  readonly #timeoutMs: number;
  readonly #url: string;

  constructor(url: string, timeoutMs: number) {
    this.#ackTimeoutMs = timeoutMs;
    this.#timeoutMs = timeoutMs;
    this.#url = url;
  }

  connect(): void {
    if (this.#raw !== null)
      throw new Error("Uptime Kuma is already connected.");
    this.#attempt(() => {
      const raw = uptimeKumaWebSocketFactory.create(this.#url);
      this.#raw = raw;
      raw.onclose = () => this.#closed();
      raw.onerror = () =>
        this.#fail(new Error("Uptime Kuma connection failed."));
      raw.onmessage = (event) => this.#message(event.data);
      this.#connectTimer = setTimeout(
        () => this.#fail(new Error("Uptime Kuma connection timed out.")),
        this.#timeoutMs,
      );
    });
  }

  disconnect(): void {
    this.#closedByClient = true;
    this.#clearConnectTimer();
    if (this.#connected) this.#raw?.send("41");
    this.#raw?.close();
    this.#rejectAcks(new Error("Uptime Kuma disconnected."));
  }

  emitWithAck(event: string, ...args: unknown[]): Promise<unknown> {
    if (!this.#connected || this.#raw === null) {
      return Promise.reject(new Error("Uptime Kuma is not connected."));
    }
    const id = this.#ackId++;
    const timeoutMs = this.#ackTimeoutMs;
    this.#ackTimeoutMs = this.#timeoutMs;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#acks.delete(id);
        reject(new Error(`Uptime Kuma did not acknowledge ${event}.`));
      }, timeoutMs);
      this.#acks.set(id, { reject, resolve, timer });
    });
    this.#raw.send(`42${id}${JSON.stringify([event, ...args])}`);
    return promise;
  }

  off(event: string, listener: SocketListener): void {
    this.#changeListeners(event, (listeners) => {
      listeners.delete(listener);
    });
  }

  once(event: string, listener: SocketListener): void {
    const current = this.#listeners.get(event);
    const listeners =
      current === undefined ? new Set<SocketListener>() : current;
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  timeout(milliseconds: number): UptimeKumaSocket {
    this.#ackTimeoutMs = milliseconds;
    return this;
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer === null) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #attempt(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.#fail(uptimeKumaConnectionError(error));
    }
  }

  #changeListeners(
    event: string,
    change: (listeners: Set<SocketListener>) => void,
  ): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) return;
    change(listeners);
    if (listeners.size === 0) this.#listeners.delete(event);
  }

  #closed(): void {
    this.#clearConnectTimer();
    const error = new Error("Uptime Kuma connection closed.");
    this.#rejectAcks(error);
    if (!this.#closedByClient && !this.#everConnected) {
      this.#emit("connect_error", error);
    }
    this.#connected = false;
  }

  #emit(event: string, ...args: unknown[]): void {
    this.#changeListeners(event, (listeners) => {
      const waiting = [...listeners];
      listeners.clear();
      for (const listener of waiting) listener(...args);
    });
  }

  #fail(error: Error): void {
    this.#clearConnectTimer();
    this.#rejectAcks(error);
    if (!this.#everConnected) this.#emit("connect_error", error);
    this.#connected = false;
    this.#raw?.close();
  }

  #message(data: unknown): void {
    this.#attempt(() => {
      if (typeof data !== "string") {
        throw new Error("Uptime Kuma sent a non-text Socket.IO frame.");
      }
      this.#readFrame(data);
    });
  }

  #readFrame(frame: string): void {
    if (frame.startsWith("0")) {
      v.parse(EngineOpenSchema, parseJson(frame.slice(1)));
      this.#raw?.send("40");
      return;
    }
    if (frame.startsWith("2")) {
      this.#raw?.send(`3${frame.slice(1)}`);
      return;
    }
    if (frame.startsWith("40")) {
      this.#connected = true;
      this.#everConnected = true;
      this.#clearConnectTimer();
      this.#emit("connect");
      return;
    }
    if (frame.startsWith("42")) {
      const [event, ...args] = parseEvent(frame.slice(2));
      this.#emit(event, ...args);
      return;
    }
    if (frame.startsWith("43")) {
      const ack = parseAck(frame);
      const pending = this.#acks.get(ack.id);
      if (pending === undefined) {
        throw new Error(`Unexpected Uptime Kuma acknowledgement ${ack.id}.`);
      }
      clearTimeout(pending.timer);
      this.#acks.delete(ack.id);
      pending.resolve(ack.value);
      return;
    }
    if (frame.startsWith("44")) {
      const response = v.parse(SocketErrorSchema, parseJson(frame.slice(2)));
      throw new Error(response.message);
    }
    if (frame === "1" || frame === "41") {
      this.#fail(new Error("Uptime Kuma disconnected."));
      return;
    }
    if (frame === "6") return;
    throw new Error("Unsupported Uptime Kuma Socket.IO frame.");
  }

  #rejectAcks(error: Error): void {
    for (const [id, pending] of this.#acks) {
      clearTimeout(pending.timer);
      this.#acks.delete(id);
      pending.reject(error);
    }
  }
}

export const createUptimeKumaSocket = (
  url: string,
  timeoutMs: number,
): UptimeKumaSocket => new KumaSocket(url, timeoutMs);
