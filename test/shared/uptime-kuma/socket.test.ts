import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  uptimeKumaConnectionError,
  uptimeKumaWebSocketFactory,
} from "#shared/uptime-kuma/socket.ts";
import { connect, FakeWebSocket, socketSetup } from "./socket/support.test.ts";

describe("Uptime Kuma native Socket.IO transport", () => {
  test("creates a platform WebSocket for the transport URL", () => {
    const raw = new FakeWebSocket();
    const urls: string[] = [];
    const webSocketConstructor = function (
      this: WebSocket,
      url: string | URL,
    ): FakeWebSocket {
      urls.push(String(url));
      return raw;
    } as unknown as typeof WebSocket;
    const target = globalThis as unknown as {
      WebSocket: (url: string | URL) => WebSocket;
    };
    using _webSocket = stub(
      target,
      "WebSocket",
      webSocketConstructor as unknown as (url: string | URL) => WebSocket,
    );

    expect(
      uptimeKumaWebSocketFactory.create(
        "wss://kuma.example.test/socket.io/?EIO=4&transport=websocket",
      ),
    ).toBe(raw);
    expect(urls).toEqual([
      "wss://kuma.example.test/socket.io/?EIO=4&transport=websocket",
    ]);
  });

  test("uses a safe connection error for a non-error value", () => {
    expect(uptimeKumaConnectionError({ password: "hidden" })).toEqual(
      new Error("Uptime Kuma connection failed."),
    );
  });

  test("connects through the Engine.IO WebSocket handshake", () => {
    using setup = socketSetup();
    let connected = 0;
    setup.socket.once("connect", () => {
      connected += 1;
    });

    connect(setup);

    expect(setup.urls).toEqual(["wss://kuma.example.test/socket.io/"]);
    expect(setup.raw.sent).toEqual(["40"]);
    expect(connected).toBe(1);
  });

  test("answers Engine.IO pings with their payload", () => {
    using setup = socketSetup();
    connect(setup);

    setup.raw.message("2probe");

    expect(setup.raw.sent).toEqual(["40", "3probe"]);
  });

  test("sends events and resolves their acknowledgements", async () => {
    using setup = socketSetup();
    connect(setup);

    const acknowledgement = setup.socket
      .timeout(500)
      .emitWithAck("login", { username: "owner" });
    setup.raw.message('430[{"ok":true}]');

    await expect(acknowledgement).resolves.toEqual({ ok: true });
    expect(setup.raw.sent).toEqual(["40", '420["login",{"username":"owner"}]']);
  });

  test("returns every acknowledgement value when Kuma sends several", async () => {
    using setup = socketSetup();
    connect(setup);

    const acknowledgement = setup.socket.emitWithAck("values");
    setup.raw.message('430["first","second"]');

    await expect(acknowledgement).resolves.toEqual(["first", "second"]);
  });

  test("increments the acknowledgement number", async () => {
    using setup = socketSetup();
    connect(setup);
    const first = setup.socket.emitWithAck("first");
    setup.raw.message('430["one"]');
    await first;

    const second = setup.socket.emitWithAck("second");
    setup.raw.message('431["two"]');

    await expect(second).resolves.toBe("two");
    expect(setup.raw.sent.slice(-2)).toEqual(['420["first"]', '421["second"]']);
  });

  test("rejects a repeated acknowledgement", async () => {
    using setup = socketSetup();
    connect(setup);
    const acknowledgement = setup.socket.emitWithAck("once");
    setup.raw.message('430["done"]');
    await acknowledgement;

    setup.raw.message('430["again"]');

    expect(setup.raw.closed).toBe(true);
  });

  test("delivers a pushed event once", () => {
    using setup = socketSetup();
    connect(setup);
    const values: unknown[] = [];
    setup.socket.once("monitorList", (value) => values.push(value));

    setup.raw.message('42["monitorList",{"7":{"id":7}}]');
    setup.raw.message('42["monitorList",{"8":{"id":8}}]');

    expect(values).toEqual([{ "7": { id: 7 } }]);
  });

  test("removes a waiting event listener", () => {
    using setup = socketSetup();
    connect(setup);
    const values: unknown[] = [];
    const listener = (value: unknown) => values.push(value);
    setup.socket.once("monitorList", listener);

    setup.socket.off("monitorList", listener);
    setup.raw.message('42["monitorList",{}]');

    expect(values).toEqual([]);
  });

  test("keeps other listeners when removing one", () => {
    using setup = socketSetup();
    connect(setup);
    const values: string[] = [];
    const removed = () => values.push("removed");
    setup.socket.once("monitorList", removed);
    setup.socket.once("monitorList", () => values.push("kept"));

    setup.socket.off("monitorList", removed);
    setup.raw.message('42["monitorList",{}]');

    expect(values).toEqual(["kept"]);
  });

  test("times out an unacknowledged event", async () => {
    using time = new FakeTime();
    using setup = socketSetup(100);
    connect(setup);
    const acknowledgement = expect(
      setup.socket.emitWithAck("slow"),
    ).rejects.toThrow("Uptime Kuma did not acknowledge slow.");

    await time.tickAsync(100);

    await acknowledgement;
  });

  test("uses a custom acknowledgement timeout", async () => {
    using time = new FakeTime();
    using setup = socketSetup(100);
    connect(setup);
    let failed = false;
    setup.socket
      .timeout(20)
      .emitWithAck("fast")
      .catch(() => {
        failed = true;
      });

    await time.tickAsync(20);

    expect(failed).toBe(true);
  });

  test("resets the acknowledgement timeout after one call", async () => {
    using time = new FakeTime();
    using setup = socketSetup(100);
    connect(setup);
    const first = setup.socket.timeout(20).emitWithAck("first");
    setup.raw.message('430["done"]');
    await first;
    let failed = false;
    setup.socket.emitWithAck("second").catch(() => {
      failed = true;
    });

    await time.tickAsync(100);

    expect(failed).toBe(true);
  });

  test("forgets an acknowledgement after it times out", async () => {
    using time = new FakeTime();
    using setup = socketSetup(100);
    connect(setup);
    const acknowledgement = setup.socket
      .emitWithAck("late")
      .catch(() => undefined);
    await time.tickAsync(100);
    await acknowledgement;

    setup.raw.message('430["too late"]');

    expect(setup.raw.closed).toBe(true);
  });

  for (const [name, frame, message] of [
    ["binary frame", new Uint8Array(), "non-text Socket.IO frame"],
    ["unknown frame", "9", "Unsupported Uptime Kuma Socket.IO frame"],
    ["bad event", "42{}", "Invalid Uptime Kuma Socket.IO event"],
    ["bad acknowledgement", "43bad", "Invalid Uptime Kuma acknowledgement"],
    [
      "bad acknowledgement data",
      "430{}",
      "Invalid Uptime Kuma acknowledgement data",
    ],
    [
      "unknown acknowledgement",
      "4399[]",
      "Unexpected Uptime Kuma acknowledgement 99",
    ],
  ] as const) {
    test(`rejects a ${name}`, async () => {
      using setup = socketSetup();
      connect(setup);
      const acknowledgement = expect(
        setup.socket.emitWithAck("pending"),
      ).rejects.toThrow(message);

      setup.raw.message(frame);

      await acknowledgement;
      expect(setup.raw.closed).toBe(true);
    });
  }

  test("rejects a call before connecting", async () => {
    using setup = socketSetup();

    await expect(setup.socket.emitWithAck("early")).rejects.toThrow(
      "Uptime Kuma is not connected.",
    );
  });

  test("rejects a second connection attempt", () => {
    using setup = socketSetup();
    setup.socket.connect();

    expect(() => setup.socket.connect()).toThrow(
      "Uptime Kuma is already connected.",
    );
    setup.socket.disconnect();
  });

  test("ignores an Engine.IO noop", () => {
    using setup = socketSetup();
    connect(setup);

    setup.raw.message("6");

    expect(setup.raw.closed).toBe(false);
  });
});
