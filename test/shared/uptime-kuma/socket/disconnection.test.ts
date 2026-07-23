import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  connect,
  connectionErrors,
  type FakeWebSocket,
  socketSetup,
} from "./support.test.ts";

describe("Uptime Kuma Socket.IO disconnection", () => {
  test("times out an incomplete connection", async () => {
    using time = new FakeTime();
    using setup = socketSetup(100);
    const errors: unknown[] = [];
    setup.socket.once("connect_error", (error) => errors.push(error));
    setup.socket.connect();

    await time.tickAsync(100);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error("Uptime Kuma connection timed out."));
    expect(setup.raw.closed).toBe(true);
  });

  test("rejects a call while the handshake is incomplete", async () => {
    using time = new FakeTime();
    using setup = socketSetup();
    setup.socket.connect();
    const acknowledgement = expect(
      setup.socket.emitWithAck("before-handshake"),
    ).rejects.toThrow("Uptime Kuma is not connected.");

    await time.tickAsync(10_000);

    await acknowledgement;
  });

  for (const [name, fail, message] of [
    [
      "WebSocket connection error",
      (raw: FakeWebSocket) => raw.error(),
      "Uptime Kuma connection failed.",
    ],
    [
      "Socket.IO connection error",
      (raw: FakeWebSocket) => raw.message('44{"message":"Not authorized."}'),
      "Not authorized.",
    ],
    [
      "server close before connecting",
      (raw: FakeWebSocket) => raw.closeFromServer(),
      "Uptime Kuma connection closed.",
    ],
  ] as const) {
    test(`reports a ${name}`, () => {
      using setup = socketSetup();

      expect(connectionErrors(setup, fail)).toEqual([new Error(message)]);
    });
  }

  test("rejects pending calls when the server disconnects", async () => {
    using setup = socketSetup();
    connect(setup);
    const acknowledgement = expect(
      setup.socket.emitWithAck("pending"),
    ).rejects.toThrow("Uptime Kuma disconnected.");

    setup.raw.message("41");

    await acknowledgement;
  });

  test("rejects pending calls when the WebSocket closes", async () => {
    using setup = socketSetup();
    connect(setup);
    const acknowledgement = expect(
      setup.socket.emitWithAck("pending"),
    ).rejects.toThrow("Uptime Kuma connection closed.");

    setup.raw.closeFromServer();

    await acknowledgement;
  });

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
      ).rejects.toThrow("Uptime Kuma is not connected.");

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

  test("handles an Engine.IO close frame", async () => {
    using setup = socketSetup();
    connect(setup);
    const acknowledgement = expect(
      setup.socket.emitWithAck("pending"),
    ).rejects.toThrow("Uptime Kuma disconnected.");

    setup.raw.message("1");

    await acknowledgement;
  });

  test("disconnects the namespace and WebSocket", () => {
    using setup = socketSetup();
    connect(setup);

    setup.socket.disconnect();

    expect(setup.raw.sent).toEqual(["40", "41"]);
    expect(setup.raw.closed).toBe(true);
  });

  test("rejects pending calls when the client disconnects", async () => {
    using setup = socketSetup();
    connect(setup);
    const acknowledgement = expect(
      setup.socket.emitWithAck("pending"),
    ).rejects.toThrow("Uptime Kuma disconnected.");

    setup.socket.disconnect();

    await acknowledgement;
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
