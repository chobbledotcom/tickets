import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { getEmailConfig, getHostEmailConfig } from "#shared/email.ts";
import { updateBusinessEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("getEmailConfig", { db: true }, () => {
  test("returns null when no provider configured", async () => {
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    const config = await getEmailConfig();
    expect(config).toBeNull();
  });

  test("returns config when all settings present", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    await settings.update.email.fromAddress("from@test.com");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const config = await getEmailConfig();
    expect(config).toEqual({
      apiKey: "test-key",
      fromAddress: "from@test.com",
      provider: "resend",
    });
  });

  test("returns null when API key missing", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.fromAddress("from@test.com");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const config = await getEmailConfig();
    expect(config).toBeNull();
  });

  test("falls back to business email when from address not set", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    await updateBusinessEmail("biz@example.com");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const config = await getEmailConfig();
    expect(config).toEqual({
      apiKey: "test-key",
      fromAddress: "biz@example.com",
      provider: "resend",
    });
  });

  test("returns null when neither from address nor business email set", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const config = await getEmailConfig();
    expect(config).toBeNull();
  });
});

describeWithEnv(
  "getHostEmailConfig",
  {
    env: {
      HOST_EMAIL_API_KEY: undefined,
      HOST_EMAIL_FROM_ADDRESS: undefined,
      HOST_EMAIL_PROVIDER: undefined,
    },
  },
  () => {
    test("returns null when no env vars set", () => {
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns null when HOST_EMAIL_PROVIDER missing", () => {
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns null when HOST_EMAIL_API_KEY missing", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns null when HOST_EMAIL_FROM_ADDRESS missing", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns config with specified provider", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toEqual({
        apiKey: "key-123",
        fromAddress: "noreply@example.com",
        provider: "resend",
      });
    });

    test("supports mailgun-eu provider", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun-eu");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toEqual({
        apiKey: "key-123",
        fromAddress: "noreply@example.com",
        provider: "mailgun-eu",
      });
    });

    test("returns null and logs error for invalid provider", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      const errorSpy = spy(console, "error");
      try {
        const config = getHostEmailConfig();
        expect(config).toBeNull();
        const logs = errorSpy.calls.map((c) => c.args[0] as string);
        expect(
          logs.some(
            (l) =>
              l.includes("E_EMAIL_SEND") &&
              l.includes("invalid HOST_EMAIL_PROVIDER"),
          ),
        ).toBe(true);
      } finally {
        errorSpy.restore();
      }
    });
  },
);
