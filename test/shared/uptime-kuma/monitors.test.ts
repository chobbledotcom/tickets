import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type {
  UptimeKumaClient,
  UptimeKumaMonitor,
} from "#shared/uptime-kuma/client.ts";
import { uptimeKumaClientApi } from "#shared/uptime-kuma/client.ts";
import {
  UPTIME_KUMA_GROUP_NAME,
  uptimeKumaMonitorService,
} from "#shared/uptime-kuma/monitors.ts";
import { withEnv } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

const kumaEnv = {
  CAN_BUILD_SITES: "true",
  UPTIME_KUMA_PASSWORD: "password",
  UPTIME_KUMA_URL: "https://kuma.example.test",
  UPTIME_KUMA_USERNAME: "owner",
};

const group = (id = 11): UptimeKumaMonitor => ({
  active: true,
  id,
  interval: 60,
  method: "GET",
  name: UPTIME_KUMA_GROUP_NAME,
  parent: null,
  type: "group",
  url: null,
});

const siteMonitor = (parent = 11): UptimeKumaMonitor => ({
  active: true,
  id: 22,
  interval: 900,
  method: "POST",
  name: "Child site",
  parent,
  type: "http",
  url: "https://child.example.test/scheduled",
});

type AddedMonitor = Record<string, unknown>;

const expectedMonitorDefaults: AddedMonitor = {
  accepted_statuscodes: ["200-299"],
  authMethod: "",
  body: null,
  databaseConnectionString: null,
  description: null,
  dns_resolve_server: "1.1.1.1",
  dns_resolve_type: "A",
  expiryNotification: false,
  headers: null,
  hostname: null,
  httpBodyEncoding: "json",
  ignoreTls: false,
  interval: 60,
  maxredirects: 10,
  maxretries: 1,
  method: "GET",
  mqttPassword: "",
  mqttSuccessMessage: "",
  mqttTopic: "",
  mqttUsername: "",
  notificationIDList: {},
  packetSize: 56,
  port: null,
  proxyId: null,
  resendInterval: 0,
  retryInterval: 60,
  timeout: 48,
  upsideDown: false,
  url: null,
};

const fakeClient = (monitors: UptimeKumaMonitor[]) => {
  const added: AddedMonitor[] = [];
  let disconnected = false;
  let nextId = 100;
  const client: UptimeKumaClient = {
    addMonitor: (monitor) => {
      added.push(monitor);
      return Promise.resolve(nextId++);
    },
    disconnect: () => {
      disconnected = true;
    },
    getMonitors: () => Promise.resolve(monitors),
    login: () => Promise.resolve(),
  };
  return {
    added,
    client,
    disconnected: () => disconnected,
  };
};

const connectFake = (monitors: UptimeKumaMonitor[]) => {
  const fake = fakeClient(monitors);
  const connection = stub(uptimeKumaClientApi, "connect", () =>
    Promise.resolve(fake.client),
  );
  return {
    ...fake,
    [Symbol.dispose]: () => connection.restore(),
  };
};

const configuredSite = () =>
  testBuiltSite({
    name: "Child site",
    scheduledTaskKey: TEST_SCHEDULED_KEY,
    siteUrl: "https://child.example.test/ignored/path",
  });

describe("Uptime Kuma built-site monitors", () => {
  test("uses the required shared group name", () => {
    expect(UPTIME_KUMA_GROUP_NAME).toBe("Chobble Tickets");
  });

  test("does not connect when Kuma is not configured", async () => {
    using _env = withEnv({
      CAN_BUILD_SITES: "true",
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_URL: undefined,
      UPTIME_KUMA_USERNAME: undefined,
    });
    let connections = 0;
    using _connect = stub(uptimeKumaClientApi, "connect", () => {
      connections += 1;
      return Promise.reject(new Error("must not connect"));
    });

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      kind: "unconfigured",
    });
    expect(connections).toBe(0);
  });

  test("does not add when Kuma is not configured", async () => {
    using _env = withEnv({
      CAN_BUILD_SITES: "true",
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_URL: undefined,
      UPTIME_KUMA_USERNAME: undefined,
    });

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      error: "Uptime Kuma is not configured.",
      ok: false,
    });
  });

  test("shows a missing monitor when the shared group does not exist", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      kind: "missing",
    });
  });

  test("shows a matching monitor from the shared group", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([group(), siteMonitor()]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      kind: "found",
      monitor: {
        active: true,
        group: UPTIME_KUMA_GROUP_NAME,
        id: 22,
        intervalSeconds: 900,
        method: "POST",
        name: "Child site",
        url: "https://child.example.test/scheduled",
      },
    });
    expect(fake.disconnected()).toBe(true);
  });

  test("ignores unrelated groups and monitors with the shared group name", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([
      group(),
      siteMonitor(),
      { ...group(31), name: "Another group" },
      {
        ...siteMonitor(31),
        id: 32,
        name: UPTIME_KUMA_GROUP_NAME,
      },
    ]);
    expect(await uptimeKumaMonitorService.load(configuredSite())).toMatchObject(
      {
        kind: "found",
        monitor: { id: 22 },
      },
    );
  });

  test("does not mistake a monitor outside the shared group for this one", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([group(), siteMonitor(99)]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      kind: "missing",
    });
  });

  test("shows connection failures without leaking credentials", async () => {
    using _env = withEnv(kumaEnv);
    using _connect = stub(uptimeKumaClientApi, "connect", () =>
      Promise.reject(new Error("connection refused")),
    );

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      error: "connection refused",
      kind: "error",
    });
  });

  test("reports duplicate shared groups as an ambiguous setup", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([group(11), group(12)]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      error: `More than one Uptime Kuma group is named "${UPTIME_KUMA_GROUP_NAME}".`,
      kind: "error",
    });
  });

  test("reports duplicate monitors as an ambiguous setup", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([
      group(),
      siteMonitor(),
      { ...siteMonitor(), id: 23 },
    ]);
    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      error:
        "More than one Uptime Kuma monitor checks https://child.example.test/scheduled.",
      kind: "error",
    });
  });

  test("creates the shared group and an authenticated POST monitor", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([]);

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      ok: true,
      value: { created: true, monitorId: 101 },
    });
    expect(fake.added).toHaveLength(2);
    expect(fake.added[0]).toEqual({
      ...expectedMonitorDefaults,
      name: UPTIME_KUMA_GROUP_NAME,
      parent: null,
      type: "group",
    });
    expect(fake.added[1]).toEqual({
      ...expectedMonitorDefaults,
      headers: JSON.stringify({
        Authorization: `Bearer ${TEST_SCHEDULED_KEY}`,
      }),
      interval: 900,
      method: "POST",
      name: "Child site",
      parent: 100,
      type: "http",
      url: "https://child.example.test/scheduled",
    });
    expect(fake.disconnected()).toBe(true);
  });

  test("adds only the monitor when the shared group exists", async () => {
    using _env = withEnv({
      ...kumaEnv,
      UPTIME_KUMA_INTERVAL_MINUTES: "3",
    });
    using fake = connectFake([group(44)]);

    expect((await uptimeKumaMonitorService.add(configuredSite())).ok).toBe(
      true,
    );
    expect(fake.added).toHaveLength(1);
    expect(fake.added[0]).toMatchObject({ interval: 180, parent: 44 });
  });

  test("reuses a monitor that was added by another request", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([group(), siteMonitor()]);

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      ok: true,
      value: { created: false, monitorId: 22 },
    });
    expect(fake.added).toEqual([]);
  });

  test("requires the retained scheduled task key before connecting", async () => {
    using _env = withEnv(kumaEnv);
    let connections = 0;
    using _connect = stub(uptimeKumaClientApi, "connect", () => {
      connections += 1;
      return Promise.reject(new Error("must not connect"));
    });

    expect(
      await uptimeKumaMonitorService.add(
        testBuiltSite({ scheduledTaskKey: null }),
      ),
    ).toEqual({
      error: "Set up scheduled maintenance before adding this monitor.",
      ok: false,
    });
    expect(connections).toBe(0);
  });

  test("reports add failures and still disconnects", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([group()]);
    fake.client.addMonitor = () => Promise.reject(new Error("add failed"));

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      error: "add failed",
      ok: false,
    });
    expect(fake.disconnected()).toBe(true);
  });

  test("uses a safe error when Kuma rejects with a non-error value", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([group()]);
    fake.client.addMonitor = () => Promise.reject({ password: "hidden" });

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      error: "Uptime Kuma failed.",
      ok: false,
    });
  });

  test("disconnects when login fails", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([]);
    fake.client.login = () => Promise.reject(new Error("login failed"));

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      error: "login failed",
      kind: "error",
    });
    expect(fake.disconnected()).toBe(true);
  });
});
