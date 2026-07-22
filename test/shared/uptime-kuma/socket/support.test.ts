import { stub } from "@std/testing/mock";
import { uptimeKumaSocketFactory } from "#shared/uptime-kuma/client.ts";
import {
  createUptimeKumaSocket,
  type UptimeKumaSocket,
  type UptimeKumaWebSocket,
  uptimeKumaWebSocketFactory,
} from "#shared/uptime-kuma/socket.ts";
import { config } from "#test/shared/uptime-kuma/client/support.test.ts";

const OPEN_FRAME =
  '0{"sid":"engine-id","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';

export class FakeWebSocket implements UptimeKumaWebSocket {
  closed = false;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];

  close(): void {
    this.closed = true;
  }

  closeFromServer(): void {
    this.onclose?.(new CloseEvent("close"));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }

  message(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

export type SocketSetup = Disposable & {
  raw: FakeWebSocket;
  socket: UptimeKumaSocket;
  urls: string[];
};

export const socketSetup = (timeoutMs = 10_000): SocketSetup => {
  const raw = new FakeWebSocket();
  const urls: string[] = [];
  const factory = stub(uptimeKumaWebSocketFactory, "create", (url) => {
    urls.push(url);
    return raw;
  });
  return {
    raw,
    socket: createUptimeKumaSocket(
      "wss://kuma.example.test/socket.io/",
      timeoutMs,
    ),
    urls,
    [Symbol.dispose]: () => factory.restore(),
  };
};

export const connect = (setup: SocketSetup): void => {
  setup.socket.connect();
  setup.raw.message(OPEN_FRAME);
  setup.raw.message('40{"sid":"socket-id"}');
};

export const connectionErrors = (
  setup: SocketSetup,
  fail: (raw: FakeWebSocket) => void,
): unknown[] => {
  const errors: unknown[] = [];
  setup.socket.once("connect_error", (error) => errors.push(error));
  setup.socket.connect();
  fail(setup.raw);
  return errors;
};

export const configuredSocketUrl = async (url: string): Promise<string> => {
  const raw = new FakeWebSocket();
  let socketUrl = "";
  using _factory = stub(uptimeKumaWebSocketFactory, "create", (value) => {
    socketUrl = value;
    return raw;
  });
  const socket = await uptimeKumaSocketFactory.create({ ...config, url });
  socket.connect();
  socket.disconnect();
  return socketUrl;
};
