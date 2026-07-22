// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { uptimeKumaClientApi } from "#shared/uptime-kuma/client.ts";
import {
  UPTIME_KUMA_GROUP_NAME,
  uptimeKumaMonitorService,
} from "#shared/uptime-kuma/monitors.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  configuredSite,
  connectFake,
  group,
  kumaEnv,
  siteMonitor,
} from "./support.test.ts";

// jscpd:ignore-end

describe("Uptime Kuma built-site monitor state", () => {
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

  test("does not treat a GET check as the scheduled maintenance monitor", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([group(), { ...siteMonitor(), method: "GET" }]);

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
