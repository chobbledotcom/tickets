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
