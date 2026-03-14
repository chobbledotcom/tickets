import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { bracket, map } from "#fp";
import { updateBusinessEmail } from "#lib/business-email.ts";
import {
  invalidateSettingsCache,
  updateEmailApiKey,
  updateEmailFromAddress,
  updateEmailProvider,
} from "#lib/db/settings.ts";
import {
  buildSvgTicketData,
  buildTicketAttachments,
  type EmailAttachment,
  type EmailConfig,
  type EmailMessage,
  getEmailConfig,
  getHostEmailConfig,
  isEmailProvider,
  sendEmail,
  sendRegistrationEmails,
  sendTestEmail,
} from "#lib/email.ts";
import {
  createTestDbWithSetup,
  makeTestEntry as makeEntry,
  resetDb,
} from "#test-utils";

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
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response()),
    );
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

  const minimalMsg: EmailMessage = {
    to: "a@b.com",
    subject: "s",
    html: "h",
    text: "t",
  };

  const getFetchArgs = (index = 0): [string, RequestInit] =>
    fetchStub.calls[index].args as [string, RequestInit];

  const getFetchJsonBody = (index = 0) =>
    JSON.parse(getFetchArgs(index)[1].body as string);

  const getFetchFormBody = (index = 0): FormData =>
    getFetchArgs(index)[1].body as FormData;

  const getFetchHeaders = (index = 0): Record<string, string> =>
    getFetchArgs(index)[1].headers as Record<string, string>;

  const findFetchCallByRecipient = (recipient: string): { args: unknown[] } => {
    const call = fetchStub.calls.find((c: { args: unknown[] }) => {
      const body = JSON.parse(
        (c.args as [string, RequestInit])[1].body as string,
      );
      return body.to[0] === recipient;
    });
    return call;
  };

  const getCallJsonBody = (call: { args: unknown[] }) =>
    JSON.parse((call.args as [string, RequestInit])[1].body as string);

  const findCallBodyByRecipient = (recipient: string) =>
    getCallJsonBody(findFetchCallByRecipient(recipient));

  const mailgunBasicAuth = `Basic ${btoa("api:re_test_key")}`;

  /** Extract string log messages from a console error spy */
  const collectErrorLogs = (errorSpy: {
    calls: { args: unknown[] }[];
  }): string[] =>
    map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);

  /** Assert that error logs contain E_EMAIL_SEND with a specific substring */
  const expectEmailSendLog = (logs: string[], substring: string): void => {
    expect(
      logs.some((l) => l.includes("E_EMAIL_SEND") && l.includes(substring)),
    ).toBe(true);
  };

  const sendWithProvider = (
    provider: EmailConfig["provider"],
    msg: EmailMessage = minimalMsg,
  ) => sendEmail({ ...testConfig, provider }, msg);

  const setupAndSendRegistration = async (
    opts: { businessEmail?: string } = {},
    entries?: ReturnType<typeof makeEntry>[],
  ) => {
    await setupDbEmailConfig(opts);
    await sendRegistrationEmails(entries ?? [makeEntry()], "GBP");
  };

  const sendEmailExpectingError = async (
    config: EmailConfig,
    msg: EmailMessage,
    expectedStatus: number | undefined,
    expectedLogSubstring: string,
  ): Promise<void> => {
    await withErrorSpy(async (errorSpy) => {
      const status = await sendEmail(config, msg);
      if (expectedStatus === undefined) {
        expect(status).toBeUndefined();
      } else {
        expect(status).toBe(expectedStatus);
      }
      expectEmailSendLog(collectErrorLogs(errorSpy), expectedLogSubstring);
    });
  };

  const setupDbEmailConfig = async (
    opts: { businessEmail?: string } = {},
  ): Promise<void> => {
    await updateEmailProvider("resend");
    await updateEmailApiKey("test-key");
    await updateEmailFromAddress("from@test.com");
    if (opts.businessEmail) {
      await updateBusinessEmail(opts.businessEmail);
    }
    invalidateSettingsCache();
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
      const [url] = getFetchArgs();
      expect(url).toBe("https://api.resend.com/emails");
      expect(getFetchHeaders()["Authorization"]).toBe("Bearer re_test_key");
      const body = getFetchJsonBody();
      expect(body.from).toBe("tickets@example.com");
      expect(body.to).toEqual(["user@test.com"]);
      expect(body.reply_to).toBe("reply@test.com");
      expect(body.subject).toBe("Test");
      expect(body.html).toBe("<p>Hi</p>");
      expect(body.text).toBe("Hi");
    });

    test("sends via Postmark with correct URL, headers, and body", async () => {
      await sendWithProvider("postmark", {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      const [url] = getFetchArgs();
      expect(url).toBe("https://api.postmarkapp.com/email");
      expect(getFetchHeaders()["X-Postmark-Server-Token"]).toBe("re_test_key");
      const body = getFetchJsonBody();
      expect(body.From).toBe("tickets@example.com");
      expect(body.To).toBe("user@test.com");
      expect(body.Subject).toBe("Test");
      expect(body.HtmlBody).toBe("<p>Hi</p>");
      expect(body.TextBody).toBe("Hi");
    });

    test("sends via SendGrid with correct URL, headers, and body", async () => {
      const msg: EmailMessage = {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
        replyTo: "reply@test.com",
      };

      await sendWithProvider("sendgrid", msg);

      const [url] = getFetchArgs();
      expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
      expect(getFetchHeaders()["Authorization"]).toBe("Bearer re_test_key");
      const body = getFetchJsonBody();
      expect(body.personalizations).toEqual([
        { to: [{ email: "user@test.com" }] },
      ]);
      expect(body.from).toEqual({ email: "tickets@example.com" });
      expect(body.reply_to).toEqual({ email: "reply@test.com" });
      expect(body.content[0]).toEqual({ type: "text/plain", value: "Hi" });
      expect(body.content[1]).toEqual({
        type: "text/html",
        value: "<p>Hi</p>",
      });
    });

    test("sends via SendGrid without reply_to when not provided", async () => {
      await sendWithProvider("sendgrid", {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(getFetchJsonBody().reply_to).toBeUndefined();
    });

    test("sends via Mailgun (US) with correct URL, headers, and FormData body", async () => {
      await sendWithProvider("mailgun-us", {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
        replyTo: "reply@test.com",
      });

      expect(fetchStub.calls.length).toBe(1);
      const [url] = getFetchArgs();
      expect(url).toBe("https://api.mailgun.net/v3/example.com/messages");
      expect(getFetchHeaders()["Authorization"]).toBe(mailgunBasicAuth);
      expect(getFetchHeaders()).not.toHaveProperty("Content-Type");
      const body = getFetchFormBody();
      expect(body.get("from")).toBe("tickets@example.com");
      expect(body.get("to")).toBe("user@test.com");
      expect(body.get("subject")).toBe("Test");
      expect(body.get("html")).toBe("<p>Hi</p>");
      expect(body.get("text")).toBe("Hi");
      expect(body.get("h:Reply-To")).toBe("reply@test.com");
    });

    test("sends via Mailgun (EU) with EU API endpoint", async () => {
      await sendWithProvider("mailgun-eu", {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(fetchStub.calls.length).toBe(1);
      const [url] = getFetchArgs();
      expect(url).toBe("https://api.eu.mailgun.net/v3/example.com/messages");
      expect(getFetchHeaders()["Authorization"]).toBe(mailgunBasicAuth);
      const body = getFetchFormBody();
      expect(body.get("from")).toBe("tickets@example.com");
      expect(body.get("to")).toBe("user@test.com");
    });

    test("sends via Mailgun without h:Reply-To when not provided", async () => {
      await sendWithProvider("mailgun-us", {
        to: "user@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(getFetchFormBody().get("h:Reply-To")).toBeNull();
    });

    test("returns status code on non-OK response", async () => {
      restubFetch(() =>
        Promise.resolve(new Response("Error", { status: 500 })),
      );

      await sendEmailExpectingError(testConfig, minimalMsg, 500, "status=500");
    });

    test("returns undefined on fetch failure", async () => {
      restubFetch(() => Promise.reject(new Error("Network error")));

      await sendEmailExpectingError(
        testConfig,
        minimalMsg,
        undefined,
        "Network error",
      );
    });

    test("returns undefined for non-Error thrown values", async () => {
      restubFetch(() => Promise.reject("string error"));

      await sendEmailExpectingError(
        testConfig,
        minimalMsg,
        undefined,
        "string error",
      );
    });

    test("returns undefined for unknown provider", async () => {
      await sendEmailExpectingError(
        { ...testConfig, provider: "invalid" as never },
        minimalMsg,
        undefined,
        "unknown provider",
      );
    });
  });

  describe("sendEmail with attachments", () => {
    const attachment: EmailAttachment = {
      filename: "ticket.svg",
      content: btoa("<svg>test</svg>"),
      contentType: "image/svg+xml",
    };
    const msgWithAttachment: EmailMessage = {
      to: "user@test.com",
      subject: "Tickets",
      html: "<p>Hi</p>",
      text: "Hi",
      attachments: [attachment],
    };

    test("Resend includes attachments with filename and content", async () => {
      await sendEmail(testConfig, msgWithAttachment);

      expect(getFetchJsonBody().attachments).toEqual([
        { filename: "ticket.svg", content: attachment.content },
      ]);
    });

    test("Postmark includes Attachments with Name, Content, ContentType", async () => {
      await sendWithProvider("postmark", msgWithAttachment);

      expect(getFetchJsonBody().Attachments).toEqual([
        {
          Name: "ticket.svg",
          Content: attachment.content,
          ContentType: "image/svg+xml",
        },
      ]);
    });

    test("SendGrid includes attachments with content, filename, type, disposition", async () => {
      await sendWithProvider("sendgrid", msgWithAttachment);

      expect(getFetchJsonBody().attachments).toEqual([
        {
          content: attachment.content,
          filename: "ticket.svg",
          type: "image/svg+xml",
          disposition: "attachment",
        },
      ]);
    });

    test("Mailgun appends attachment as Blob to FormData", async () => {
      await sendWithProvider("mailgun-us", msgWithAttachment);

      const body = getFetchFormBody();
      const file = body.get("attachment") as File;
      expect(file).toBeInstanceOf(File);
      expect(file.name).toBe("ticket.svg");
      expect(file.type).toBe("image/svg+xml");
    });

    test("omits attachments field when no attachments provided", async () => {
      await sendEmail(testConfig, minimalMsg);

      expect(getFetchJsonBody().attachments).toBeUndefined();
    });
  });

  describe("buildSvgTicketData", () => {
    test("maps entry fields to SvgTicketData", () => {
      const data = buildSvgTicketData(
        makeEntry(
          { name: "Concert" },
          { quantity: 2, price_paid: "1500", ticket_token: "tok123" },
        ),
        "GBP",
      );
      expect(data.eventName).toBe("Concert");
      expect(data.quantity).toBe(2);
      expect(data.pricePaid).toBe("1500");
      expect(data.checkinUrl).toContain("/checkin/tok123");
    });

    test("includes attendee date for daily events", () => {
      const data = buildSvgTicketData(
        makeEntry({}, { date: "2026-06-15" }),
        "GBP",
      );
      expect(data.attendeeDate).toBe("2026-06-15");
    });

    test("includes event date and location from event", () => {
      const data = buildSvgTicketData(
        makeEntry({ date: "2026-07-01T19:00:00Z", location: "Town Hall" }),
        "GBP",
      );
      expect(data.eventDate).toBe("2026-07-01T19:00:00Z");
      expect(data.eventLocation).toBe("Town Hall");
    });
  });

  describe("buildTicketAttachments", () => {
    test("generates one attachment per entry", async () => {
      const entries = [
        makeEntry({}, { ticket_token: "tok1" }),
        makeEntry({}, { ticket_token: "tok2" }),
      ];
      const attachments = await buildTicketAttachments(entries, "GBP");

      expect(attachments.length).toBe(2);
      expect(attachments[0]!.filename).toBe("ticket-1.svg");
      expect(attachments[1]!.filename).toBe("ticket-2.svg");
      expect(attachments[0]!.contentType).toBe("image/svg+xml");
    });

    test("uses 'ticket.svg' filename for single entry", async () => {
      const attachments = await buildTicketAttachments([makeEntry()], "GBP");

      expect(attachments.length).toBe(1);
      expect(attachments[0]!.filename).toBe("ticket.svg");
    });

    test("attachment content is base64-encoded SVG", async () => {
      const attachments = await buildTicketAttachments([makeEntry()], "GBP");

      const decoded = atob(attachments[0]!.content);
      expect(decoded).toContain("<svg");
      expect(decoded).toContain("</svg>");
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
      expect(config).toEqual({
        provider: "resend",
        apiKey: "test-key",
        fromAddress: "from@test.com",
      });
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
      expect(config).toEqual({
        provider: "resend",
        apiKey: "test-key",
        fromAddress: "biz@example.com",
      });
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

    test("returns null and logs error for invalid provider", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      await withErrorSpy((errorSpy) => {
        const config = getHostEmailConfig();
        expect(config).toBeNull();
        expectEmailSendLog(
          collectErrorLogs(errorSpy),
          "invalid HOST_EMAIL_PROVIDER",
        );
      });
    });
  });

  describe("sendRegistrationEmails", () => {
    afterEach(() => {
      Deno.env.delete("HOST_EMAIL_PROVIDER");
      Deno.env.delete("HOST_EMAIL_API_KEY");
      Deno.env.delete("HOST_EMAIL_FROM_ADDRESS");
    });

    test("skips when attendee has no email address", async () => {
      await setupAndSendRegistration({}, [makeEntry({}, { email: "" })]);
      expect(fetchStub.calls.length).toBe(0);
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
      await setupAndSendRegistration();

      expect(fetchStub.calls.length).toBe(1);
      const [url] = fetchStub.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://api.resend.com/emails");
    });

    test("sends confirmation email to attendee", async () => {
      await setupAndSendRegistration();

      expect(fetchStub.calls.length).toBe(1);
      const body = getFetchJsonBody();
      expect(body.to).toEqual(["jane@example.com"]);
      expect(body.subject).toContain("Test Event");
    });

    test("sends both confirmation and admin notification when business email set", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      expect(fetchStub.calls.length).toBe(2);
      const recipients = fetchStub.calls.map(
        (c: { args: unknown[] }) => getCallJsonBody(c).to,
      );
      expect(recipients).toContainEqual(["jane@example.com"]);
      expect(recipients).toContainEqual(["admin@business.com"]);
    });

    test("uses business email as reply-to on confirmation", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      const body = findCallBodyByRecipient("jane@example.com");
      expect(body.reply_to).toBe("admin@business.com");
    });

    test("uses attendee email as reply-to on admin notification", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      const body = findCallBodyByRecipient("admin@business.com");
      expect(body.reply_to).toBe("jane@example.com");
    });

    test("attaches SVG ticket to confirmation email", async () => {
      await setupAndSendRegistration();

      const body = getFetchJsonBody();
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].filename).toBe("ticket.svg");
      const decoded = atob(body.attachments[0].content);
      expect(decoded).toContain("<svg");
    });

    test("does not attach tickets to admin notification", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      const body = findCallBodyByRecipient("admin@business.com");
      expect(body.attachments).toBeUndefined();
    });

    test("attaches numbered tickets for multi-event registration", async () => {
      const entries = [
        makeEntry({ name: "Event A" }, { ticket_token: "tok1" }),
        makeEntry({ name: "Event B" }, { ticket_token: "tok2" }),
      ];
      await setupAndSendRegistration({}, entries);

      const body = getFetchJsonBody();
      expect(body.attachments).toHaveLength(2);
      expect(body.attachments[0].filename).toBe("ticket-1.svg");
      expect(body.attachments[1].filename).toBe("ticket-2.svg");
    });
  });

  describe("sendTestEmail", () => {
    test("sends test email and returns status code", async () => {
      const status = await sendTestEmail(testConfig, "admin@test.com");

      expect(status).toBe(200);
      expect(fetchStub.calls.length).toBe(1);
      const body = getFetchJsonBody();
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
