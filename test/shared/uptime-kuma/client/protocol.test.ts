import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  createUptimeKumaClient,
  type UptimeKumaClient,
} from "#shared/uptime-kuma/client.ts";
import { FakeSocket } from "./support.test.ts";

const clientAtVersion = (
  socket: FakeSocket,
  version = "2.4.0",
): UptimeKumaClient => {
  const client = createUptimeKumaClient(socket);
  socket.emitEvent("info", { version });
  return client;
};

const successfulLoginClient = (
  socket: FakeSocket,
  version = "2.4.0",
): UptimeKumaClient => {
  socket.reply("login", { ok: true, token: "session-token" });
  return clientAtVersion(socket, version);
};

describe("Uptime Kuma Socket.IO protocol", () => {
  test("logs in with the username and password payload", async () => {
    const socket = new FakeSocket();
    const client = successfulLoginClient(socket);

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
    ).rejects.toMatchObject({ kind: "two_factor" });
  });

  test("accepts Uptime Kuma 2.4", async () => {
    const socket = new FakeSocket();
    const client = successfulLoginClient(socket);

    await expect(client.login("owner", "secret")).resolves.toBeUndefined();
  });

  test("accepts later Uptime Kuma versions", async () => {
    const socket = new FakeSocket();
    const client = successfulLoginClient(socket, "12.3.4");

    await expect(client.login("owner", "secret")).resolves.toBeUndefined();
  });

  test("sends login before waiting for the versioned info event", async () => {
    const socket = new FakeSocket();
    socket.reply("login", { ok: true, token: "session-token" });
    const client = createUptimeKumaClient(socket);
    socket.emitEvent("info", { latestVersion: "2.4.0" });
    const login = client.login("owner", "secret");
    expect(socket.calls).toHaveLength(1);
    expect(socket.calls[0]?.event).toBe("login");

    socket.emitEvent("info", { version: "2.4.0" });

    await expect(login).resolves.toBeUndefined();
  });

  for (const version of ["1.23.16", "2.3.1", "next"]) {
    test(`rejects unsupported Uptime Kuma version ${version}`, async () => {
      const socket = new FakeSocket();
      const client = successfulLoginClient(socket, version);

      await expect(client.login("owner", "secret")).rejects.toMatchObject({
        kind: "unsupported_version",
      });
    });
  }

  test("times out when Kuma does not send its version", async () => {
    using time = new FakeTime();
    const socket = new FakeSocket();
    socket.reply("login", { ok: true, token: "session-token" });
    const version = expect(
      createUptimeKumaClient(socket).login("owner", "secret"),
    ).rejects.toMatchObject({ kind: "version_timeout" });

    await time.tickAsync(10_001);

    await version;
  });

  test("requests and validates the pushed monitor list", async () => {
    using time = new FakeTime();
    const socket = new FakeSocket();
    socket.reply("getMonitorList", () => {
      socket.emitEvent("monitorList", {
        "1": {
          accepted_statuscodes: ["200-299"],
          active: 1,
          authMethod: "",
          bearer_token: null,
          headers: null,
          id: 1,
          interval: 1,
          method: "POST",
          name: "Child",
          parent: 1,
          type: "http",
          url: "https://child.example.test/scheduled",
        },
        "8": {
          accepted_statuscodes: ["200-299"],
          active: 0,
          authMethod: "",
          bearer_token: null,
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
          accepted_statuscodes: ["204"],
          active: true,
          authMethod: "",
          bearer_token: null,
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
        acceptedStatusCodes: ["200-299"],
        active: true,
        authorization: null,
        id: 1,
        interval: 1,
        method: "POST",
        name: "Child",
        parent: 1,
        type: "http",
        url: "https://child.example.test/scheduled",
      },
      {
        acceptedStatusCodes: ["200-299"],
        active: false,
        authorization: null,
        id: 8,
        interval: 60,
        method: "GET",
        name: "Chobble Tickets",
        parent: null,
        type: "group",
        url: null,
      },
      {
        acceptedStatusCodes: ["204"],
        active: true,
        authorization: null,
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

  test("uses the monitor list paired with the request acknowledgement", async () => {
    const socket = new FakeSocket();
    socket.reply("getMonitorList", () => {
      socket.emitEvent("monitorList", {});
      socket.emitEvent("monitorList", {
        "7": {
          accepted_statuscodes: ["200-299"],
          active: true,
          authMethod: "",
          bearer_token: null,
          headers: null,
          id: 7,
          interval: 60,
          method: "POST",
          name: "Current monitor",
          parent: null,
          type: "http",
          url: "https://current.example.test",
        },
      });
      return { ok: true };
    });

    expect(await createUptimeKumaClient(socket).getMonitors()).toMatchObject([
      { id: 7, name: "Current monitor" },
    ]);
    expect(socket.timeoutMs).toBe(60_000);
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
    let failed = false;
    const outcome = createUptimeKumaClient(socket)
      .getMonitors()
      .catch((error) => {
        failed = true;
        return error;
      });

    await time.tickAsync(10_001);

    expect(failed).toBe(false);

    await time.tickAsync(50_000);
    expect(await outcome).toMatchObject({ kind: "monitor_list_timeout" });
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
            accepted_statuscodes: ["200-299"],
            active: true,
            authMethod: "",
            bearer_token: null,
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
      ).rejects.toMatchObject({ kind: "invalid_response" });
    });
  }

  test("returns the monitor number from an add acknowledgement", async () => {
    const socket = new FakeSocket();
    socket.reply("add", { monitorID: 1, msg: "Added.", ok: true });
    const input = { name: "Child", type: "http" };

    expect(await createUptimeKumaClient(socket).addMonitor(input)).toBe(1);
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
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("disconnects the wrapped socket", () => {
    const socket = new FakeSocket();

    createUptimeKumaClient(socket).disconnect();

    expect(socket.disconnected).toBe(true);
    expect(socket.listenerCount("info")).toBe(0);
  });
});
