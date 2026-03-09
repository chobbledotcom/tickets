import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import {
  type EmailConfig,
  type EmailMessage,
  getEmailConfig,
  getHostEmailConfig,
  isEmailProvider,
  sendEmail,
  sendRegistrationEmails,
  sendTestEmail,
} from "#lib/email.ts";
import type { RegistrationEntry, WebhookAttendee, WebhookEvent } from "#lib/webhook.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils";
import {
  invalidateSettingsCache,
  updateEmailApiKey,
  updateEmailFromAddress,
  updateEmailProvider,
} from "#lib/db/settings.ts";
import { updateBusinessEmail } from "#lib/business-email.ts";
import { bracket, map } from "#fp";

const makeEvent = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
  id: 1,
  name: "Test Event",
  slug: "test-event",
  webhook_url: "",
  max_attendees: 100,
  attendee_count: 10,
  unit_price: 0,
  can_pay_more: false,
  ...overrides,
});

const makeAttendee = (overrides: Partial<WebhookAttendee> = {}): WebhookAttendee => ({
  id: 42,
  quantity: 1,
  name: "Jane Doe",
  email: "jane@example.com",
  phone: "555-1234",
  address: "",
  special_instructions: "",
  payment_id: "",
  price_paid: "0",
  ticket_token: "AABB001122",
  date: null,
  ...overrides,
});

const makeEntry = (
  eventOverrides?: Partial<WebhookEvent>,
  attendeeOverrides?: Partial<WebhookAttendee>,
): RegistrationEntry => ({
  event: makeEvent(eventOverrides),
  attendee: makeAttendee(attendeeOverrides),
});

const testConfig: EmailConfig = {
  provider: "resend",
  apiKey: "re_test_key",
  fromAddress: "tickets@example.com",
};

const withErrorSpy = bracket(
  () => spy(console, "error"),
  (s: { restore: () => void }) => s.restore(),
);

describe("email", () => {
  // deno-lint-ignore no-explicit-any
  let fetchStub: any;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    fetchStub = stub(globalThis, "fetch", () => Promise.resolve(new Response()));
    await createTestDbWithSetup();
  });

  afterEach(() => {
    fetchStub.restore();
    globalThis.fetch = originalFetch;
    resetDb();
  });

  const restubFetch = (impl: () => Promise<Response>): void => {
    fetchStub.restore();
    fetchStub = stub(globalThis, "fetch", impl);
  };

  describe("sendEmail", () => {
    test("sends via Resend with correct URL, headers, and body", async () => {
      const msg: EmailMessage = {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
        replyTo: "reply@test.com",
      };

      const status = await sendEmail(testConfig, msg);

      expect(status).toBe(200);
      expect(fetchStub.calls.length).toBe(1);
      const [url, opts] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.resend.com/emails");
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_test_key");
      const body = JSON.parse(opts.body as string);
      expect(body.from).toBe("tickets@example.com");
      expect(body.to).toEqual(["user@test.com"]);
      expect(body.reply_to).toBe("reply@test.com");
      expect(body.subject).toBe("Test");
      expect(body.html).toBe("<p>Hi</p>");
      expect(body.text).toBe("Hi");
    });

    test("sends via Postmark with correct URL, headers, and body", async () => {
      const config: EmailConfig = { ...testConfig, provider: "postmark" };
      const msg: EmailMessage = { to: "user@test.com", subject: "Test", html: "<p>Hi</p>", text: "Hi" };

      await sendEmail(config, msg);

      const [url, opts] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.postmarkapp.com/email");
      expect((opts.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("re_test_key");
      const body = JSON.parse(opts.body as string);
      expect(body.From).toBe("tickets@example.com");
      expect(body.To).toBe("user@test.com");
      expect(body.Subject).toBe("Test");
      expect(body.HtmlBody).toBe("<p>Hi</p>");
      expect(body.TextBody).toBe("Hi");
    });

    test("sends via SendGrid with correct URL, headers, and body", async () => {
      const config: EmailConfig = { ...testConfig, provider: "sendgrid" };
      const msg: EmailMessage = {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
        replyTo: "reply@test.com",
      };

      await sendEmail(config, msg);

      const [url, opts] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_test_key");
      const body = JSON.parse(opts.body as string);
      expect(body.personalizations).toEqual([{ to: [{ email: "user@test.com" }] }]);
      expect(body.from).toEqual({ email: "tickets@example.com" });
      expect(body.reply_to).toEqual({ email: "reply@test.com" });
      expect(body.content[0]).toEqual({ type: "text/plain", value: "Hi" });
      expect(body.content[1]).toEqual({ type: "text/html", value: "<p>Hi</p>" });
    });

    test("sends via SendGrid without reply_to when not provided", async () => {
      const config: EmailConfig = { ...testConfig, provider: "sendgrid" };
      const msg: EmailMessage = { to: "user@test.com", subject: "Test", html: "<p>Hi</p>", text: "Hi" };

      await sendEmail(config, msg);

      const body = JSON.parse((fetchStub.calls[0].args as [string, RequestInit])[1].body as string);
      expect(body.reply_to).toBeUndefined();
    });

    test("sends via Mailgun (US) with correct URL, headers, and FormData body", async () => {
      const config: EmailConfig = { ...testConfig, provider: "mailgun-us" };
      const msg: EmailMessage = {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
        replyTo: "reply@test.com",
      };

      await sendEmail(config, msg);

      expect(fetchStub.calls.length).toBe(1);
      const [url, opts] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.mailgun.net/v3/example.com/messages");
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
        `Basic ${btoa("api:re_test_key")}`,
      );
      expect(opts.headers as Record<string, string>).not.toHaveProperty("Content-Type");
      const body = opts.body as FormData;
      expect(body.get("from")).toBe("tickets@example.com");
      expect(body.get("to")).toBe("user@test.com");
      expect(body.get("subject")).toBe("Test");
      expect(body.get("html")).toBe("<p>Hi</p>");
      expect(body.get("text")).toBe("Hi");
      expect(body.get("h:Reply-To")).toBe("reply@test.com");
    });

    test("sends via Mailgun (EU) with EU API endpoint", async () => {
      const config: EmailConfig = { ...testConfig, provider: "mailgun-eu" };
      const msg: EmailMessage = {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      };

      await sendEmail(config, msg);

      expect(fetchStub.calls.length).toBe(1);
      const [url, opts] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.eu.mailgun.net/v3/example.com/messages");
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
        `Basic ${btoa("api:re_test_key")}`,
      );
      const body = opts.body as FormData;
      expect(body.get("from")).toBe("tickets@example.com");
      expect(body.get("to")).toBe("user@test.com");
    });

    test("sends via Mailgun without h:Reply-To when not provided", async () => {
      const config: EmailConfig = { ...testConfig, provider: "mailgun-us" };
      const msg: EmailMessage = { to: "user@test.com", subject: "Test", html: "<p>Hi</p>", text: "Hi" };

      await sendEmail(config, msg);

      const body = (fetchStub.calls[0].args as [string, RequestInit])[1].body as FormData;
      expect(body.get("h:Reply-To")).toBeNull();
    });

    test("returns status code on non-OK response", async () => {
      restubFetch(() => Promise.resolve(new Response("Error", { status: 500 })));

      await withErrorSpy(async (errorSpy) => {
        const status = await sendEmail(testConfig, { to: "a@b.com", subject: "s", html: "h", text: "t" });
        expect(status).toBe(500);
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("E_EMAIL_SEND") && l.includes("status=500"))).toBe(true);
      });
    });

    test("returns undefined on fetch failure", async () => {
      restubFetch(() => Promise.reject(new Error("Network error")));

      await withErrorSpy(async (errorSpy) => {
        const status = await sendEmail(testConfig, { to: "a@b.com", subject: "s", html: "h", text: "t" });
        expect(status).toBeUndefined();
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("E_EMAIL_SEND") && l.includes("Network error"))).toBe(true);
      });
    });

    test("returns undefined for non-Error thrown values", async () => {
      restubFetch(() => Promise.reject("string error"));

      await withErrorSpy(async (errorSpy) => {
        const status = await sendEmail(testConfig, { to: "a@b.com", subject: "s", html: "h", text: "t" });
        expect(status).toBeUndefined();
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("E_EMAIL_SEND") && l.includes("string error"))).toBe(true);
      });
    });

    test("returns undefined for unknown provider", async () => {
      await withErrorSpy(async (errorSpy) => {
        const status = await sendEmail({ ...testConfig, provider: "invalid" as never }, { to: "a@b.com", subject: "s", html: "h", text: "t" });
        expect(status).toBeUndefined();
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("E_EMAIL_SEND") && l.includes("unknown provider"))).toBe(true);
      });
    });
  });

  describe("getEmailConfig", () => {
    test("returns null when no provider configured", async () => {
      invalidateSettingsCache();
      const config = await getEmailConfig();
      expect(config).toBeNull();
    });

    test("returns config when all settings present", async () => {
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      await updateEmailFromAddress("from@test.com");
      invalidateSettingsCache();

      const config = await getEmailConfig();
      expect(config).toEqual({ provider: "resend", apiKey: "test-key", fromAddress: "from@test.com" });
    });

    test("returns null when API key missing", async () => {
      await updateEmailProvider("resend");
      await updateEmailFromAddress("from@test.com");
      invalidateSettingsCache();

      const config = await getEmailConfig();
      expect(config).toBeNull();
    });

    test("falls back to business email when from address not set", async () => {
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      await updateBusinessEmail("biz@example.com");
      invalidateSettingsCache();

      const config = await getEmailConfig();
      expect(config).toEqual({ provider: "resend", apiKey: "test-key", fromAddress: "biz@example.com" });
    });

    test("returns null when neither from address nor business email set", async () => {
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      invalidateSettingsCache();

      const config = await getEmailConfig();
      expect(config).toBeNull();
    });
  });

  describe("getHostEmailConfig", () => {
    afterEach(() => {
      Deno.env.delete("HOST_EMAIL_PROVIDER");
      Deno.env.delete("HOST_EMAIL_API_KEY");
      Deno.env.delete("HOST_EMAIL_FROM_ADDRESS");
    });

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
  });

  describe("sendRegistrationEmails", () => {
    afterEach(() => {
      Deno.env.delete("HOST_EMAIL_PROVIDER");
      Deno.env.delete("HOST_EMAIL_API_KEY");
      Deno.env.delete("HOST_EMAIL_FROM_ADDRESS");
    });

    test("skips when email not configured", async () => {
      await sendRegistrationEmails([makeEntry()], "GBP");
      expect(fetchStub.calls.length).toBe(0);
    });

    test("falls back to host email config when no DB email provider", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun-us");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      invalidateSettingsCache();

      await sendRegistrationEmails([makeEntry()], "GBP");

      expect(fetchStub.calls.length).toBe(1);
      const [url] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.mailgun.net/v3/example.com/messages");
    });

    test("prefers DB email provider over host email config", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun-us");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      await updateEmailFromAddress("from@test.com");
      invalidateSettingsCache();

      await sendRegistrationEmails([makeEntry()], "GBP");

      expect(fetchStub.calls.length).toBe(1);
      const [url] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.resend.com/emails");
    });

    test("sends confirmation email to attendee", async () => {
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      await updateEmailFromAddress("from@test.com");
      invalidateSettingsCache();

      await sendRegistrationEmails([makeEntry()], "GBP");

      expect(fetchStub.calls.length).toBe(1);
      const body = JSON.parse((fetchStub.calls[0].args as [string, RequestInit])[1].body as string);
      expect(body.to).toEqual(["jane@example.com"]);
      expect(body.subject).toContain("Test Event");
    });

    test("sends both confirmation and admin notification when business email set", async () => {
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      await updateEmailFromAddress("from@test.com");
      await updateBusinessEmail("admin@business.com");
      invalidateSettingsCache();

      await sendRegistrationEmails([makeEntry()], "GBP");

      expect(fetchStub.calls.length).toBe(2);
      const recipients = fetchStub.calls.map(
        (c: { args: unknown[] }) => JSON.parse((c.args as [string, RequestInit])[1].body as string).to,
      );
      expect(recipients).toContainEqual(["jane@example.com"]);
      expect(recipients).toContainEqual(["admin@business.com"]);
    });

    test("uses business email as reply-to on confirmation", async () => {
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      await updateEmailFromAddress("from@test.com");
      await updateBusinessEmail("admin@business.com");
      invalidateSettingsCache();

      await sendRegistrationEmails([makeEntry()], "GBP");

      const confirmationCall = fetchStub.calls.find((c: { args: unknown[] }) => {
        const body = JSON.parse((c.args as [string, RequestInit])[1].body as string);
        return body.to[0] === "jane@example.com";
      });
      const body = JSON.parse((confirmationCall.args as [string, RequestInit])[1].body as string);
      expect(body.reply_to).toBe("admin@business.com");
    });

    test("uses attendee email as reply-to on admin notification", async () => {
      await updateEmailProvider("resend");
      await updateEmailApiKey("test-key");
      await updateEmailFromAddress("from@test.com");
      await updateBusinessEmail("admin@business.com");
      invalidateSettingsCache();

      await sendRegistrationEmails([makeEntry()], "GBP");

      const adminCall = fetchStub.calls.find((c: { args: unknown[] }) => {
        const body = JSON.parse((c.args as [string, RequestInit])[1].body as string);
        return body.to[0] === "admin@business.com";
      });
      const body = JSON.parse((adminCall.args as [string, RequestInit])[1].body as string);
      expect(body.reply_to).toBe("jane@example.com");
    });
  });

  describe("sendTestEmail", () => {
    test("sends test email and returns status code", async () => {
      const status = await sendTestEmail(testConfig, "admin@test.com");

      expect(status).toBe(200);
      expect(fetchStub.calls.length).toBe(1);
      const body = JSON.parse((fetchStub.calls[0].args as [string, RequestInit])[1].body as string);
      expect(body.to).toEqual(["admin@test.com"]);
      expect(body.subject).toContain("Test email");
    });
  });

  describe("isEmailProvider", () => {
    test("returns true for valid providers", () => {
      expect(isEmailProvider("resend")).toBe(true);
      expect(isEmailProvider("postmark")).toBe(true);
      expect(isEmailProvider("sendgrid")).toBe(true);
      expect(isEmailProvider("mailgun-us")).toBe(true);
      expect(isEmailProvider("mailgun-eu")).toBe(true);
    });

    test("returns false for invalid providers", () => {
      expect(isEmailProvider("invalid")).toBe(false);
      expect(isEmailProvider("")).toBe(false);
    });
  });
});
