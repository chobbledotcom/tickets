import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { createUptimeKumaClient } from "#shared/uptime-kuma/client.ts";
import { FakeSocket } from "./support.test.ts";

describe("Uptime Kuma Socket.IO protocol", () => {
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
          headers: null,
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
          headers: null,
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
        headers: "must not cross the gateway",
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
        headers: null,
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
        headers: null,
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
            headers: null,
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

    expect(socket.disconnected).toBe(true);
  });
});
