import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { UptimeKumaError } from "#shared/uptime-kuma/error.ts";
import {
  connect,
  connectionErrors,
  type FakeWebSocket,
  type SocketSetup,
  socketSetup,
} from "./support.test.ts";

const pendingCallClosures: readonly [string, (setup: SocketSetup) => void][] = [
  ["the server disconnects", ({ raw }) => raw.message("41")],
  ["the WebSocket closes", ({ raw }) => raw.closeFromServer()],
  ["an Engine.IO close frame arrives", ({ raw }) => raw.message("1")],
  ["the client disconnects", ({ socket }) => socket.disconnect()],
];

describe("Uptime Kuma Socket.IO disconnection", () => {
  test("times out an incomplete connection", async () => {
    using time = new FakeTime();
    using setup = socketSetup(100);
    const errors: unknown[] = [];
    setup.socket.once("connect_error", (error) => errors.push(error));
    setup.socket.connect();

    await time.tickAsync(100);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new UptimeKumaError("connection_timeout"));
    expect(setup.raw.closed).toBe(true);
  });

  test("rejects a call while the handshake is incomplete", async () => {
    using time = new FakeTime();
    using setup = socketSetup();
    setup.socket.connect();
    const acknowledgement = expect(
      setup.socket.emitWithAck("before-handshake"),
    ).rejects.toMatchObject({ kind: "connection_closed" });

    await time.tickAsync(10_000);

    await acknowledgement;
  });

  for (const [name, fail, error] of [
    [
      "WebSocket connection error",
      (raw: FakeWebSocket) => raw.error(),
      new UptimeKumaError("connection_failed"),
    ],
    [
      "Socket.IO connection error",
      (raw: FakeWebSocket) => raw.message('44{"message":"Not authorized."}'),
      new Error("Not authorized."),
    ],
    [
      "server close before connecting",
      (raw: FakeWebSocket) => raw.closeFromServer(),
      new UptimeKumaError("connection_closed"),
    ],
  ] as const) {
    test(`reports a ${name}`, () => {
      using setup = socketSetup();

      expect(connectionErrors(setup, fail)).toEqual([error]);
    });
  }

  for (const [name, close] of pendingCallClosures) {
    test(`rejects pending calls when ${name}`, async () => {
      using setup = socketSetup();
      connect(setup);
      const acknowledgement = expect(
        setup.socket.emitWithAck("pending"),
      ).rejects.toMatchObject({ kind: "connection_closed" });

      close(setup);

      await acknowledgement;
    });
  }

  for (const [name, fail] of [
    ["WebSocket closes", (raw: FakeWebSocket) => raw.closeFromServer()],
    ["protocol fails", (raw: FakeWebSocket) => raw.message("9")],
  ] as const) {
    test(`rejects a new call after the ${name}`, async () => {
      using time = new FakeTime();
      using setup = socketSetup();
      connect(setup);
      fail(setup.raw);
      const acknowledgement = expect(
        setup.socket.emitWithAck("after-disconnect"),
      ).rejects.toMatchObject({ kind: "connection_closed" });

      await time.tickAsync(10_000);

      await acknowledgement;
    });
  }

  test("does not report a connection error after connecting", () => {
    using setup = socketSetup();
    connect(setup);
    const errors: unknown[] = [];
    setup.socket.once("connect_error", (error) => errors.push(error));

    setup.raw.message("9");
    setup.raw.closeFromServer();

    expect(errors).toEqual([]);
  });

  test("disconnects the namespace and WebSocket", () => {
    using setup = socketSetup();
    connect(setup);

    setup.socket.disconnect();

    expect(setup.raw.sent).toEqual(["40", "41"]);
    expect(setup.raw.closed).toBe(true);
  });

  test("does not report a close after disconnecting before connect", () => {
    using setup = socketSetup();
    const errors: unknown[] = [];
    setup.socket.once("connect_error", (error) => errors.push(error));
    setup.socket.connect();
    setup.socket.disconnect();

    setup.raw.closeFromServer();

    expect(errors).toEqual([]);
  });
});
