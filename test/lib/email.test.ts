import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import {
  type EmailConfig,
  type EmailMessage,
  getEmailConfig,
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

      await sendEmail(testConfig, msg);

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

    test("logs error on non-OK response", async () => {
      restubFetch(() => Promise.resolve(new Response("Error", { status: 500 })));

      await withErrorSpy(async (errorSpy) => {
        await sendEmail(testConfig, { to: "a@b.com", subject: "s", html: "h", text: "t" });
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("E_EMAIL_SEND") && l.includes("status=500"))).toBe(true);
      });
    });

    test("logs error on fetch failure", async () => {
      restubFetch(() => Promise.reject(new Error("Network error")));

      await withErrorSpy(async (errorSpy) => {
        await sendEmail(testConfig, { to: "a@b.com", subject: "s", html: "h", text: "t" });
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("E_EMAIL_SEND") && l.includes("Network error"))).toBe(true);
      });
    });

    test("logs error for unknown provider", async () => {
      await withErrorSpy(async (errorSpy) => {
        await sendEmail({ ...testConfig, provider: "invalid" }, { to: "a@b.com", subject: "s", html: "h", text: "t" });
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
  });

  describe("sendRegistrationEmails", () => {
    test("skips when email not configured", async () => {
      await sendRegistrationEmails([makeEntry()], "GBP");
      expect(fetchStub.calls.length).toBe(0);
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
    test("sends test email to specified address", async () => {
      await sendTestEmail(testConfig, "admin@test.com");

      expect(fetchStub.calls.length).toBe(1);
      const body = JSON.parse((fetchStub.calls[0].args as [string, RequestInit])[1].body as string);
      expect(body.to).toEqual(["admin@test.com"]);
      expect(body.subject).toContain("Test email");
    });
  });
});
