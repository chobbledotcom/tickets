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
import { testBuiltSite } from "#test-utils/factories.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";
import {
  addRaceCases,
  configuredSite,
  connectFake,
  expectedMonitorDefaults,
  group,
  kumaEnv,
  runChangingAdd,
  siteMonitor,
} from "./support.test.ts";

// jscpd:ignore-end

describe("adding Uptime Kuma built-site monitors", () => {
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

  test("adds a POST monitor when only a GET check exists", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([group(), { ...siteMonitor(), method: "GET" }]);

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      ok: true,
      value: { created: true, monitorId: 100 },
    });
    expect(fake.added).toHaveLength(1);
    expect(fake.added[0]).toMatchObject({ method: "POST", parent: 11 });
  });

  for (const scenario of addRaceCases) {
    test(scenario.name, async () => {
      const outcome = await runChangingAdd(scenario.reads);

      expect(outcome.result).toEqual({
        ok: true,
        value: {
          created: scenario.created,
          monitorId: scenario.monitorId,
        },
      });
      expect(outcome.added).toHaveLength(scenario.addedCount);
      expect(outcome.deleted).toEqual(scenario.deleted);
      if (scenario.addedParent !== undefined) {
        expect(outcome.added.at(-1)).toMatchObject({
          parent: scenario.addedParent,
          type: "http",
        });
      }
    });
  }

  test("reports a created group that Kuma omits from its list", async () => {
    const outcome = await runChangingAdd([[], []]);

    expect(outcome.result).toEqual({
      error: `Uptime Kuma did not return the new "${UPTIME_KUMA_GROUP_NAME}" group.`,
      ok: false,
    });
  });

  test("reports a created monitor that Kuma omits from its list", async () => {
    const outcome = await runChangingAdd([[group()], [group()], [group()]]);

    expect(outcome.result).toEqual({
      error:
        "Uptime Kuma did not return the new monitor for https://child.example.test/scheduled.",
      ok: false,
    });
  });

  test("refuses to add when the shared group has duplicate monitors", async () => {
    using _env = withEnv(kumaEnv);
    using _fake = connectFake([
      group(),
      siteMonitor(),
      { ...siteMonitor(), id: 23 },
    ]);

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      error:
        "More than one Uptime Kuma monitor checks https://child.example.test/scheduled.",
      ok: false,
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
});
