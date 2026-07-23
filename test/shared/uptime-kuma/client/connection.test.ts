import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  uptimeKumaClientApi,
  uptimeKumaSocketFactory,
} from "#shared/uptime-kuma/client.ts";
import { UptimeKumaError } from "#shared/uptime-kuma/error.ts";
import { configuredSocketUrl } from "#test/shared/uptime-kuma/socket/support.test.ts";
import { config, FakeSocket, useSocketFactory } from "./support.test.ts";

const expectDisconnected = (socket: FakeSocket): void => {
  expect(socket.disconnected).toBe(true);
  expect(socket.listenerCount("connect")).toBe(0);
  expect(socket.listenerCount("connect_error")).toBe(0);
};

describe("Uptime Kuma Socket.IO connection", () => {
  test("connects before returning a client", async () => {
    const socket = new FakeSocket();
    using _factory = useSocketFactory(socket);

    const client = await uptimeKumaClientApi.connect(config);
    client.disconnect();

    expectDisconnected(socket);
  });

  test("accepts the Kuma version sent during connection", async () => {
    const socket = new FakeSocket();
    socket.connectInfo = { version: "2.4.0" };
    socket.reply("login", { ok: true, token: "session-token" });
    using _factory = useSocketFactory(socket);

    const client = await uptimeKumaClientApi.connect(config);

    await expect(client.login("owner", "secret")).resolves.toBeUndefined();
    client.disconnect();
  });

  test("disconnects after a connection error", async () => {
    const socket = new FakeSocket();
    socket.connectError = new Error("socket refused");
    using _factory = useSocketFactory(socket);

    await expect(uptimeKumaClientApi.connect(config)).rejects.toThrow(
      "socket refused",
    );
    expectDisconnected(socket);
  });

  test("uses a safe message for a malformed connection error", async () => {
    const socket = new FakeSocket();
    socket.connectError = { password: "must not leak" };
    using _factory = useSocketFactory(socket);

    await expect(uptimeKumaClientApi.connect(config)).rejects.toEqual(
      new UptimeKumaError("connection_failed"),
    );
  });

  test("uses the configured base path and native WebSocket transport", async () => {
    await runWithSubrequestBudget(async () => {
      expect(await configuredSocketUrl(config.url)).toBe(
        "wss://kuma.example.test/status/socket.io/?EIO=4&transport=websocket",
      );
      expect(getSubrequestUsage().external).toBe(1);
    });
  });

  test("uses the root Socket.IO path for a root Kuma URL", async () => {
    expect(await configuredSocketUrl("https://kuma.example.test")).toBe(
      "wss://kuma.example.test/socket.io/?EIO=4&transport=websocket",
    );
  });

  test("uses an unencrypted WebSocket for a local HTTP Kuma URL", async () => {
    expect(await configuredSocketUrl("http://localhost:3001")).toBe(
      "ws://localhost:3001/socket.io/?EIO=4&transport=websocket",
    );
  });

  test("names a blocked Kuma connection in the subrequest error", async () => {
    await expect(
      withSubrequestAllowance({ database: 50, external: 0, total: 50 }, () =>
        uptimeKumaSocketFactory.create(config),
      ),
    ).rejects.toEqual(
      new Error(
        "Subrequest allowance exceeded: 0 database + 1 external calls. " +
          "Blocked external operation: Uptime Kuma socket connection",
      ),
    );
  });
});
