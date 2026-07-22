import { stub } from "@std/testing/mock";
import type { UptimeKumaSocket } from "#shared/uptime-kuma/client.ts";
import { uptimeKumaSocketFactory } from "#shared/uptime-kuma/client.ts";
import type { UptimeKumaConfig } from "#shared/uptime-kuma/config.ts";

type Listener = (...args: unknown[]) => void;
type Reply = unknown | ((...args: unknown[]) => unknown);

export class FakeSocket implements UptimeKumaSocket {
  calls: Array<{ args: unknown[]; event: string }> = [];
  connectError: unknown = null;
  disconnected = false;
  timeoutMs = 0;
  #listeners = new Map<string, Set<Listener>>();
  #replies = new Map<string, Reply>();

  connect(): void {
    this.emitEvent(
      this.connectError === null ? "connect" : "connect_error",
      this.connectError,
    );
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emitEvent(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args);
    }
    this.#listeners.delete(event);
  }

  emitWithAck(event: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ args, event });
    if (!this.#replies.has(event)) {
      return Promise.reject(new Error(`No reply for ${event}`));
    }
    const reply = this.#replies.get(event);
    return Promise.resolve(
      typeof reply === "function" ? reply(...args) : reply,
    );
  }

  off(event: string, listener: Listener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  once(event: string, listener: Listener): void {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  reply(event: string, value: Reply): void {
    this.#replies.set(event, value);
  }

  timeout(milliseconds: number): UptimeKumaSocket {
    this.timeoutMs = milliseconds;
    return this;
  }
}

export const config: UptimeKumaConfig = {
  intervalSeconds: 900,
  password: "password",
  url: "https://kuma.example.test/status",
  username: "owner",
};

export const useSocketFactory = (socket: UptimeKumaSocket): Disposable => {
  const factory = stub(uptimeKumaSocketFactory, "create", () =>
    Promise.resolve(socket),
  );
  return { [Symbol.dispose]: () => factory.restore() };
};
