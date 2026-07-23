// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { t } from "#i18n";
import {
  UptimeKumaClientError,
  type UptimeKumaClientErrorKind,
  uptimeKumaClientApi,
} from "#shared/uptime-kuma/client.ts";
import { UPTIME_KUMA_GROUP_NAME } from "#shared/uptime-kuma/monitor-input.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  configuredSite,
  connectFake,
  group,
  kumaEnv,
  runWithKeylessSite,
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

  test("shows a missing monitor without a retained key", async () => {
    const outcome = await runWithKeylessSite((site) =>
      uptimeKumaMonitorService.load(site),
    );

    expect(outcome.result).toEqual({ kind: "missing" });
    expect(outcome.connections).toBe(0);
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

  test("matches an equivalent scheduled URL with trailing slashes", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([
      group(),
      { ...siteMonitor(), url: "https://child.example.test/scheduled//" },
    ]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toMatchObject(
      { kind: "found", monitor: { id: 22 } },
    );
  });

  test("shows a paused matching monitor", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([
      group(),
      { ...siteMonitor(), active: false, interval: 3_600 },
    ]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toMatchObject(
      {
        kind: "found",
        monitor: { active: false, id: 22, intervalSeconds: 3_600 },
      },
    );
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

  test("does not reuse a monitor that rejects the scheduled 204 response", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([group(), siteMonitor(11, ["200"])]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
      kind: "missing",
    });
  });

  test("matches a monitor that accepts exactly the scheduled 204 response", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([group(), siteMonitor(11, ["204"])]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toMatchObject(
      { kind: "found", monitor: { id: 22 } },
    );
  });

  for (const acceptedStatusCodes of [["200-399"], ["100-599"]]) {
    test(`matches a monitor whose ${acceptedStatusCodes[0]} range includes 204`, async () => {
      using _env = withEnv(kumaEnv);
      using _fake = connectFake([
        group(),
        siteMonitor(11, acceptedStatusCodes),
      ]);

      expect(
        await uptimeKumaMonitorService.load(configuredSite()),
      ).toMatchObject({ kind: "found", monitor: { id: 22 } });
    });
  }

  for (const acceptedStatusCodes of [["205-399"], ["100-203"]]) {
    test(`ignores a monitor whose ${acceptedStatusCodes[0]} range excludes 204`, async () => {
      using _env = withEnv(kumaEnv);
      using _fake = connectFake([
        group(),
        siteMonitor(11, acceptedStatusCodes),
      ]);

      expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
        kind: "missing",
      });
    });
  }

  for (const [label, authorization] of [
    ["no bearer authorization", null],
    ["the wrong bearer authorization", "Bearer wrong"],
  ] as const) {
    test(`does not treat a POST check with ${label} as the monitor`, async () => {
      using _env = withEnv(kumaEnv);
      using _fake = connectFake([group(), { ...siteMonitor(), authorization }]);

      expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
        kind: "missing",
      });
    });
  }

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

  for (const scenario of [
    {
      kind: "unsupported_version",
      messageKey: "built_sites.kuma_unsupported_version",
      name: "uses catalog copy for an unsupported version",
    },
    {
      kind: "two_factor",
      messageKey: "built_sites.kuma_two_factor",
      name: "uses catalog copy for two-factor login",
    },
    {
      kind: "version_timeout",
      messageKey: "built_sites.kuma_version_timeout",
      name: "uses catalog copy for a missing version",
    },
    {
      kind: "monitor_list_timeout",
      messageKey: "built_sites.kuma_monitor_list_timeout",
      name: "uses catalog copy for a missing monitor list",
    },
  ] satisfies Array<{
    kind: UptimeKumaClientErrorKind;
    messageKey: string;
    name: string;
  }>) {
    test(scenario.name, async () => {
      using _env = withEnv(kumaEnv);
      using fake = connectFake([]);
      fake.client.login = () =>
        Promise.reject(new UptimeKumaClientError(scenario.kind));

      expect(await uptimeKumaMonitorService.load(configuredSite())).toEqual({
        error: t(scenario.messageKey),
        kind: "error",
      });
    });
  }

  test("finds a monitor across duplicate shared groups", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([group(11), group(12), siteMonitor(12)]);

    expect(await uptimeKumaMonitorService.load(configuredSite())).toMatchObject(
      { kind: "found", monitor: { id: 22 } },
    );
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
