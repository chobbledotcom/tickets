// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest, t } from "#i18n";
import { UptimeKumaError } from "#shared/uptime-kuma/error.ts";
import { UPTIME_KUMA_GROUP_NAME } from "#shared/uptime-kuma/monitor-input.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { withEnv } from "#test-utils/env.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";
import {
  addRaceCases,
  configuredSite,
  connectFake,
  group,
  kumaEnv,
  runChangingAdd,
  runWithKeylessSite,
  siteMonitor,
} from "./support.test.ts";

// jscpd:ignore-end

const expectMonitorReuse = async (
  monitor: ReturnType<typeof siteMonitor>,
): Promise<void> => {
  using _env = withEnv(kumaEnv);
  using fake = connectFake([group(), monitor]);

  expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
    ok: true,
    value: { created: false, monitorId: 22 },
  });
  expect(fake.added).toEqual([]);
};

describe("adding Uptime Kuma built-site monitors", () => {
  test("does not add when Kuma is not configured", async () => {
    using _env = withEnv({
      CAN_BUILD_SITES: "true",
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_URL: undefined,
      UPTIME_KUMA_USERNAME: undefined,
    });

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      error: t("built_sites.kuma_add_unconfigured"),
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

  test("reuses an equivalent scheduled URL with a trailing slash", async () => {
    await expectMonitorReuse({
      ...siteMonitor(),
      url: "https://child.example.test/scheduled/",
    });
  });

  test("adds an authenticated monitor when a POST check has no authorization", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([
      group(),
      { ...siteMonitor(), authorization: null },
    ]);

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      ok: true,
      value: { created: true, monitorId: 100 },
    });
    expect(fake.added[0]).toMatchObject({
      authMethod: "bearer",
      bearer_token: TEST_SCHEDULED_KEY,
      headers: null,
    });
  });

  test("includes the Uptime Kuma JSON defaults", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([group()]);

    await uptimeKumaMonitorService.add(configuredSite());

    expect(fake.added[0]).toMatchObject({
      conditions: [],
      kafkaProducerBrokers: [],
      kafkaProducerSaslOptions: { mechanism: "None" },
      rabbitmqNodes: [],
    });
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

  test("does not delete a group after another request can attach a monitor", async () => {
    const outcome = await runChangingAdd(
      [
        [],
        [group(99), group(100)],
        [group(99), group(100), { ...siteMonitor(99), id: 101 }],
      ],
      () => {
        throw new Error("Another request attached a monitor before deletion.");
      },
    );

    expect(outcome.result).toEqual({
      ok: true,
      value: { created: false, monitorId: 101 },
    });
    expect(outcome.deleted).toEqual([]);
  });

  test("reports a created group that Kuma omits from its list", async () => {
    const outcome = await runChangingAdd([[], []]);

    expect(outcome.result).toEqual({
      error: t("built_sites.kuma_new_group_missing", {
        name: UPTIME_KUMA_GROUP_NAME,
      }),
      ok: false,
    });
  });

  test("reports a created monitor that Kuma omits from its list", async () => {
    const outcome = await runChangingAdd([[group()], [group()], [group()]]);

    expect(outcome.result).toEqual({
      error: t("built_sites.kuma_new_monitor_missing", {
        url: "https://child.example.test/scheduled",
      }),
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
      error: t("built_sites.kuma_duplicate_monitor", {
        url: "https://child.example.test/scheduled",
      }),
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
    expect(fake.added[0]).toMatchObject({
      name: UPTIME_KUMA_GROUP_NAME,
      parent: null,
      type: "group",
    });
    expect(fake.added[1]).toMatchObject({
      authMethod: "bearer",
      bearer_token: TEST_SCHEDULED_KEY,
      headers: null,
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

  test("uses the lowest duplicate shared group without deleting either", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([group(100), group(99)]);

    await uptimeKumaMonitorService.add(configuredSite());

    expect(fake.added[0]).toMatchObject({ parent: 99, type: "http" });
    expect(fake.deleted).toEqual([]);
  });

  test("reuses a monitor that was added by another request", async () => {
    await expectMonitorReuse(siteMonitor());
  });

  test("requires the retained scheduled task key before connecting", async () => {
    const outcome = await runWithKeylessSite((site) =>
      uptimeKumaMonitorService.add(site),
    );

    expect(outcome.result).toEqual({
      error: t("built_sites.kuma_needs_key"),
      ok: false,
    });
    expect(outcome.connections).toBe(0);
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

  test("uses catalog copy for an unsupported Kuma version", async () => {
    using _env = withEnv(kumaEnv);
    using fake = connectFake([]);
    fake.client.login = () =>
      Promise.reject(new UptimeKumaError("unsupported_version"));

    expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
      error: t("built_sites.kuma_unsupported_version"),
      ok: false,
    });
  });

  test("uses catalog copy when Kuma rejects with a non-error value", async () => {
    using _env = withEnv({
      ...kumaEnv,
      I18N_REPLACEMENTS: "failed|stopped",
    });
    resetI18nForTest();
    try {
      using fake = connectFake([group()]);
      fake.client.addMonitor = () => Promise.reject({ password: "hidden" });

      expect(await uptimeKumaMonitorService.add(configuredSite())).toEqual({
        error: "Uptime Kuma stopped.",
        ok: false,
      });
    } finally {
      resetI18nForTest();
    }
  });
});
