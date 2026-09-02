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

  test("rejects an interval without Kuma credentials", () => {
    using _env = withEnv({
      CAN_BUILD_SITES: "true",
      UPTIME_KUMA_INTERVAL_MINUTES: "7",
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_URL: undefined,
      UPTIME_KUMA_USERNAME: undefined,
    });

    expect(getUptimeKumaConfigOrNull).toThrow(
      "UPTIME_KUMA_URL, UPTIME_KUMA_USERNAME and UPTIME_KUMA_PASSWORD must all be set",
    );
    expect(getEnabledUptimeKumaConfigOrNull).toThrow(
      "UPTIME_KUMA_URL, UPTIME_KUMA_USERNAME and UPTIME_KUMA_PASSWORD must all be set",
    );
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

  test("allows a configured interval longer than the default", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_INTERVAL_MINUTES: "60",
    });

    expect(getUptimeKumaConfigOrNull()?.intervalSeconds).toBe(3_600);
  });

  test("accepts a local HTTP server", () => {
    using _env = withEnv({
      ...configuredEnv,
      UPTIME_KUMA_URL: "http://127.0.0.1:3001",
    });

    expect(getUptimeKumaConfigOrNull()?.url).toBe("http://127.0.0.1:3001");
  });

  for (const url of [
    "http://localhost:3001",
    "http://kuma.localhost:3001",
    "http://127.0.0.5:3001",
    "http://[::1]:3001",
    "http://10.0.1.2:3001",
    "http://100.64.0.1:3001",
    "http://100.127.1.2:3001",
    "http://169.254.10.5:3001",
    "http://172.16.0.1:3001",
    "http://172.31.255.255:3001",
    "http://192.168.1.10:3001",
    "http://[fd00::1]:3001",
    "http://[fd7a:115c:a1e0::1]:3001",
    "http://[fc00::1]:3001",
    "http://[fe80::1]:3001",
    "http://[feb0::1]:3001",
    "http://localhost.:3001",
    "http://kuma.localhost.:3001",
  ]) {
    test(`accepts the local network HTTP host ${url}`, () => {
      using _env = withEnv({ ...configuredEnv, UPTIME_KUMA_URL: url });

      expect(getUptimeKumaConfigOrNull()?.url).toBe(url);
    });
  }

  for (const url of [
    "http://kuma.example.test",
    "http://0.0.0.0",
    "http://8.8.8.8:3001",
    "http://9.0.0.1:3001",
    "http://11.0.0.1:3001",
    "http://100.63.1.2:3001",
    "http://100.128.1.2:3001",
    "http://169.255.1.2:3001",
    "http://172.15.0.1:3001",
    "http://172.32.0.1:3001",
    "http://192.169.0.1:3001",
    "http://10.0.1.x:3001",
    "http://10.0.0.1e0:3001",
    "http://[::ffff:127.0.0.1]",
    "http://[2001:db8::1]:3001",
    "http://[ff02::1]:3001",
    "http://[fec0::1]:3001",
    "http://[ff00::1]:3001",
  ]) {
    test(`rejects the public HTTP host ${url}`, () => {
      using _env = withEnv({ ...configuredEnv, UPTIME_KUMA_URL: url });

      expect(getUptimeKumaConfigOrNull).toThrow(
        "UPTIME_KUMA_URL must use HTTPS outside a local network",
      );
    });
  }

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

  for (const malformed of ["not a URL", "http://999.1.2.3:3001"]) {
    test(`rejects the malformed URL ${malformed}`, () => {
      using _env = withEnv({
        ...configuredEnv,
        UPTIME_KUMA_URL: malformed,
      });

      expect(getUptimeKumaConfigOrNull).toThrow(
        "UPTIME_KUMA_URL must be a valid URL",
      );
    });
  }

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
