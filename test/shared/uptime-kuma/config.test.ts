import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getEnabledUptimeKumaConfigOrNull,
  getUptimeKumaConfigOrNull,
  validateUptimeKumaConfig,
} from "#shared/uptime-kuma/config.ts";
import { withEnv } from "#test-utils/env.ts";

const configuredEnv = {
  CAN_BUILD_SITES: "true",
  UPTIME_KUMA_PASSWORD: "secret password",
  UPTIME_KUMA_URL: "https://kuma.example.test/status/",
  UPTIME_KUMA_USERNAME: "tickets",
};

describe("Uptime Kuma configuration", () => {
  test("is disabled when no Kuma setting is present", () => {
    using _env = withEnv({
      CAN_BUILD_SITES: "true",
      UPTIME_KUMA_INTERVAL_MINUTES: undefined,
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_URL: undefined,
      UPTIME_KUMA_USERNAME: undefined,
    });

    expect(getUptimeKumaConfigOrNull()).toBeNull();
    expect(getEnabledUptimeKumaConfigOrNull()).toBeNull();
  });

  test("uses a 15 minute default and normalizes the base URL", () => {
    using _env = withEnv(configuredEnv);

    expect(getUptimeKumaConfigOrNull()).toEqual({
      intervalSeconds: 900,
      password: "secret password",
      url: "https://kuma.example.test/status",
      username: "tickets",
    });
    expect(getEnabledUptimeKumaConfigOrNull()).not.toBeNull();
  });

  test("uses the configured whole-minute interval", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_INTERVAL_MINUTES: "7",
    });

    expect(getUptimeKumaConfigOrNull()?.intervalSeconds).toBe(420);
  });

  test("accepts a local HTTP server", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_URL: "http://127.0.0.1:3001",
    });

    expect(getUptimeKumaConfigOrNull()?.url).toBe("http://127.0.0.1:3001");
  });

  test("stays disabled when site building is off", () => {
    using _env = withEnv({ ...configuredEnv, CAN_BUILD_SITES: "false" });

    expect(getUptimeKumaConfigOrNull()).not.toBeNull();
    expect(getEnabledUptimeKumaConfigOrNull()).toBeNull();
  });

  for (const missing of [
    "UPTIME_KUMA_URL",
    "UPTIME_KUMA_USERNAME",
    "UPTIME_KUMA_PASSWORD",
  ] as const) {
    test(`rejects credentials missing ${missing}`, () => {
      using _env = withEnv({ ...configuredEnv, [missing]: undefined });

      expect(getUptimeKumaConfigOrNull).toThrow(
        "UPTIME_KUMA_URL, UPTIME_KUMA_USERNAME and UPTIME_KUMA_PASSWORD must all be set",
      );
    });
  }

  for (const blank of [
    "UPTIME_KUMA_URL",
    "UPTIME_KUMA_USERNAME",
    "UPTIME_KUMA_PASSWORD",
  ] as const) {
    test(`rejects blank ${blank}`, () => {
      using _env = withEnv({ ...configuredEnv, [blank]: "   " });

      expect(getUptimeKumaConfigOrNull).toThrow(`${blank} must not be blank`);
    });
  }

  test("rejects non-HTTP URLs", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_URL: "ftp://kuma.example.test",
    });

    expect(getUptimeKumaConfigOrNull).toThrow(
      "UPTIME_KUMA_URL must use http or https",
    );
  });

  test("rejects malformed URLs", () => {
    using _env = withEnv({ ...configuredEnv, UPTIME_KUMA_URL: "not a URL" });

    expect(getUptimeKumaConfigOrNull).toThrow(
      "UPTIME_KUMA_URL must be a valid URL",
    );
  });

  for (const url of [
    "https://user@kuma.example.test",
    "https://:secret@kuma.example.test",
  ]) {
    test(`rejects credentials in ${url}`, () => {
      using _env = withEnv({ ...configuredEnv, UPTIME_KUMA_URL: url });

      expect(getUptimeKumaConfigOrNull).toThrow(
        "UPTIME_KUMA_URL must not contain a username or password",
      );
    });
  }

  test("rejects a query in the base URL", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_URL: "https://kuma.example.test/?view=all",
    });

    expect(getUptimeKumaConfigOrNull).toThrow(
      "UPTIME_KUMA_URL must not contain a query or fragment",
    );
  });

  test("rejects a fragment in the base URL", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_URL: "https://kuma.example.test/#top",
    });

    expect(getUptimeKumaConfigOrNull).toThrow(
      "UPTIME_KUMA_URL must not contain a query or fragment",
    );
  });

  test("rejects an interval that overflows when converted to seconds", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_INTERVAL_MINUTES: String(Number.MAX_SAFE_INTEGER),
    });

    expect(getUptimeKumaConfigOrNull).toThrow(
      "UPTIME_KUMA_INTERVAL_MINUTES is too large",
    );
  });

  for (const interval of ["", "0", "1.5", "fifteen"]) {
    test(`rejects the invalid interval ${interval}`, () => {
      using _env = withEnv({
        ...configuredEnv,
        UPTIME_KUMA_INTERVAL_MINUTES: interval,
      });

      expect(getUptimeKumaConfigOrNull).toThrow(
        "UPTIME_KUMA_INTERVAL_MINUTES must be a positive whole number",
      );
    });
  }

  test("boot validation reads the Kuma configuration", () => {
    using _env = withEnv({
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_URL: configuredEnv.UPTIME_KUMA_URL,
      UPTIME_KUMA_USERNAME: configuredEnv.UPTIME_KUMA_USERNAME,
    });

    expect(validateUptimeKumaConfig).toThrow(
      "UPTIME_KUMA_URL, UPTIME_KUMA_USERNAME and UPTIME_KUMA_PASSWORD must all be set",
    );
  });
});
