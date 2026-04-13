import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { updateBusinessEmail } from "#lib/business-email.ts";
import { settings } from "#lib/db/settings.ts";
import { getEmailConfig, getHostEmailConfig } from "#lib/email.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("getEmailConfig", { db: true }, () => {
  test("returns null when no provider configured", async () => {
    settings.invalidateCache();
    await settings.loadAll();
    const config = await getEmailConfig();
    expect(config).toBeNull();
  });

  test("returns config when all settings present", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    await settings.update.email.fromAddress("from@test.com");
    settings.invalidateCache();
    await settings.loadAll();

    const config = await getEmailConfig();
    expect(config).toEqual({
      provider: "resend",
      apiKey: "test-key",
      fromAddress: "from@test.com",
    });
  });

  test("returns null when API key missing", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.fromAddress("from@test.com");
    settings.invalidateCache();
    await settings.loadAll();

    const config = await getEmailConfig();
    expect(config).toBeNull();
  });

  test("falls back to business email when from address not set", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    await updateBusinessEmail("biz@example.com");
    settings.invalidateCache();
    await settings.loadAll();

    const config = await getEmailConfig();
    expect(config).toEqual({
      provider: "resend",
      apiKey: "test-key",
      fromAddress: "biz@example.com",
    });
  });

  test("returns null when neither from address nor business email set", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    settings.invalidateCache();
    await settings.loadAll();

    const config = await getEmailConfig();
    expect(config).toBeNull();
  });
});

describeWithEnv(
  "getHostEmailConfig",
  {
    env: {
      HOST_EMAIL_PROVIDER: undefined,
      HOST_EMAIL_API_KEY: undefined,
      HOST_EMAIL_FROM_ADDRESS: undefined,
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
        provider: "resend",
        apiKey: "key-123",
        fromAddress: "noreply@example.com",
      });
    });

    test("supports mailgun-eu provider", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun-eu");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toEqual({
        provider: "mailgun-eu",
        apiKey: "key-123",
        fromAddress: "noreply@example.com",
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
