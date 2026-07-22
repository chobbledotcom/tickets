import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  createUptimeKumaClient,
  type UptimeKumaSocket,
  uptimeKumaClientApi,
  uptimeKumaSocketFactory,
} from "#shared/uptime-kuma/client.ts";
import type { UptimeKumaConfig } from "#shared/uptime-kuma/config.ts";

type Listener = (...args: unknown[]) => void;
type Reply = unknown | ((...args: unknown[]) => unknown);

class FakeSocket implements UptimeKumaSocket {
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

const config: UptimeKumaConfig = {
  intervalSeconds: 900,
  password: "password",
  url: "https://kuma.example.test/status",
  username: "owner",
};

const returnSocket = (socket: UptimeKumaSocket) =>
  stub(uptimeKumaSocketFactory, "create", () => Promise.resolve(socket));

const expectDisconnected = (socket: FakeSocket): void => {
  expect(socket.disconnected).toBe(true);
  expect(socket.listenerCount("connect")).toBe(0);
  expect(socket.listenerCount("connect_error")).toBe(0);
};

describe("Uptime Kuma Socket.IO client", () => {
  test("logs in with the username and password payload", async () => {
    const socket = new FakeSocket();
    socket.reply("login", { ok: true, token: "session-token" });
    const client = createUptimeKumaClient(socket);

    await client.login("owner", "secret");

    expect(socket.calls).toEqual([
      {
        args: [{ password: "secret", token: "", username: "owner" }],
        event: "login",
      },
    ]);
    expect(socket.timeoutMs).toBe(10_000);
  });

  test("reports rejected credentials", async () => {
    const socket = new FakeSocket();
    socket.reply("login", { msg: "Incorrect password.", ok: false });

    await expect(
      createUptimeKumaClient(socket).login("owner", "wrong"),
    ).rejects.toThrow("Incorrect password.");
  });

  test("reports unsupported two-factor login", async () => {
    const socket = new FakeSocket();
    socket.reply("login", { tokenRequired: true });

    await expect(
      createUptimeKumaClient(socket).login("owner", "password"),
    ).rejects.toThrow("two-factor login is not supported");
  });

  test("requests and validates the pushed monitor list", async () => {
    using time = new FakeTime();
    const socket = new FakeSocket();
    socket.reply("getMonitorList", () => {
      socket.emitEvent("monitorList", {
        "7": {
          active: 1,
          headers: "must not cross the gateway",
          id: 7,
          interval: 900,
          method: "POST",
          name: "Child",
          parent: 3,
          type: "http",
          url: "https://child.example.test/scheduled",
        },
        "8": {
          active: 0,
          id: 8,
          interval: 60,
          method: "GET",
          name: "Chobble Tickets",
          parent: null,
          type: "group",
          url: null,
        },
        "9": {
          active: true,
          id: 9,
          interval: 120,
          method: "GET",
          name: "Boolean active",
          parent: null,
          type: "http",
          url: "https://active.example.test",
        },
      });
      return { ok: true };
    });

    expect(await createUptimeKumaClient(socket).getMonitors()).toEqual([
      {
        active: true,
        id: 7,
        interval: 900,
        method: "POST",
        name: "Child",
        parent: 3,
        type: "http",
        url: "https://child.example.test/scheduled",
      },
      {
        active: false,
        id: 8,
        interval: 60,
        method: "GET",
        name: "Chobble Tickets",
        parent: null,
        type: "group",
        url: null,
      },
      {
        active: true,
        id: 9,
        interval: 120,
        method: "GET",
        name: "Boolean active",
        parent: null,
        type: "http",
        url: "https://active.example.test",
      },
    ]);
    expect(time.next()).toBe(false);
  });

  test("reports a rejected monitor-list request", async () => {
    const socket = new FakeSocket();
    socket.reply("getMonitorList", () => {
      socket.emitEvent("monitorList", {});
      return { msg: "Not logged in.", ok: false };
    });

    await expect(createUptimeKumaClient(socket).getMonitors()).rejects.toThrow(
      "Not logged in.",
    );
  });

  test("cleans up the monitor listener when the request fails", async () => {
    const socket = new FakeSocket();
    socket.reply("getMonitorList", () =>
      Promise.reject(new Error("socket closed")),
    );

    await expect(createUptimeKumaClient(socket).getMonitors()).rejects.toThrow(
      "socket closed",
    );
    expect(socket.listenerCount("monitorList")).toBe(0);
  });

  test("times out when Kuma does not push its monitor list", async () => {
    using time = new FakeTime();
    const socket = new FakeSocket();
    socket.reply("getMonitorList", { ok: true });
    const outcome = expect(
      createUptimeKumaClient(socket).getMonitors(),
    ).rejects.toThrow("Uptime Kuma did not send monitorList.");

    await time.tickAsync(10_000);
    await outcome;
    expect(socket.listenerCount("monitorList")).toBe(0);
  });

  for (const [field, value] of [
    ["id", 0],
    ["interval", 0],
    ["parent", 0],
  ] as const) {
    test(`rejects a monitor whose ${field} is ${value}`, async () => {
      const socket = new FakeSocket();
      socket.reply("getMonitorList", () => {
        socket.emitEvent("monitorList", {
          bad: {
            active: true,
            id: 1,
            interval: 60,
            method: "POST",
            name: "Bad monitor",
            parent: null,
            type: "http",
            url: "https://bad.example.test",
            [field]: value,
          },
        });
        return { ok: true };
      });

      await expect(
        createUptimeKumaClient(socket).getMonitors(),
      ).rejects.toThrow();
    });
  }

  test("returns the monitor number from an add acknowledgement", async () => {
    const socket = new FakeSocket();
    socket.reply("add", { monitorID: 41, msg: "Added.", ok: true });
    const input = { name: "Child", type: "http" };

    expect(await createUptimeKumaClient(socket).addMonitor(input)).toBe(41);
    expect(socket.calls[0]).toEqual({ args: [input], event: "add" });
  });

  test("reports a rejected add acknowledgement", async () => {
    const socket = new FakeSocket();
    socket.reply("add", { msg: "Invalid monitor.", ok: false });

    await expect(createUptimeKumaClient(socket).addMonitor({})).rejects.toThrow(
      "Invalid monitor.",
    );
  });

  test("deletes a monitor by number", async () => {
    const socket = new FakeSocket();
    socket.reply("deleteMonitor", { msg: "Deleted.", ok: true });

    await createUptimeKumaClient(socket).deleteMonitor(41);

    expect(socket.calls[0]).toEqual({ args: [41], event: "deleteMonitor" });
  });

  test("reports a rejected monitor deletion", async () => {
    const socket = new FakeSocket();
    socket.reply("deleteMonitor", { msg: "Monitor not found.", ok: false });

    await expect(
      createUptimeKumaClient(socket).deleteMonitor(41),
    ).rejects.toThrow("Monitor not found.");
  });

  test("rejects a zero monitor number from an add acknowledgement", async () => {
    const socket = new FakeSocket();
    socket.reply("add", { monitorID: 0, ok: true });

    await expect(
      createUptimeKumaClient(socket).addMonitor({}),
    ).rejects.toThrow();
  });

  test("disconnects the wrapped socket", () => {
    const socket = new FakeSocket();

    createUptimeKumaClient(socket).disconnect();

    expectDisconnected(socket);
  });

  test("connects before returning a client", async () => {
    const socket = new FakeSocket();
    using _factory = returnSocket(socket);

    const client = await uptimeKumaClientApi.connect(config);
    client.disconnect();

    expectDisconnected(socket);
  });

  test("disconnects after a connection error", async () => {
    const socket = new FakeSocket();
    socket.connectError = new Error("socket refused");
    using _factory = returnSocket(socket);

    await expect(uptimeKumaClientApi.connect(config)).rejects.toThrow(
      "socket refused",
    );
    expectDisconnected(socket);
  });

  test("uses a safe message for a malformed connection error", async () => {
    const socket = new FakeSocket();
    socket.connectError = { password: "must not leak" };
    using _factory = returnSocket(socket);

    await expect(uptimeKumaClientApi.connect(config)).rejects.toThrow(
      "Uptime Kuma connection failed.",
    );
  });

  test("places the Socket.IO endpoint under the configured base path", async () => {
    await runWithSubrequestBudget(async () => {
      const socket = await uptimeKumaSocketFactory.create(config);
      const manager = socket as unknown as {
        io: {
          opts: {
            autoConnect: boolean;
            path: string;
            reconnection: boolean;
            timeout: number;
            transports: unknown[];
          };
        };
      };

      expect(manager.io.opts).toMatchObject({
        autoConnect: false,
        path: "/status/socket.io",
        reconnection: false,
        timeout: 10_000,
        transports: ["websocket"],
      });
      expect(getSubrequestUsage().external).toBe(1);
      socket.disconnect();
    });
  });

  test("places a root Kuma server at the root Socket.IO path", async () => {
    const socket = await uptimeKumaSocketFactory.create({
      ...config,
      url: "https://kuma.example.test",
    });
    const manager = socket as unknown as { io: { opts: { path: string } } };

    expect(manager.io.opts.path).toBe("/socket.io");
    socket.disconnect();
  });

  test("names a blocked Kuma connection in the subrequest error", async () => {
    await expect(
      withSubrequestAllowance({ database: 50, external: 0, total: 50 }, () =>
        uptimeKumaSocketFactory.create(config),
      ),
    ).rejects.toThrow(
      "Blocked external operation: Uptime Kuma socket connection",
    );
  });
});
