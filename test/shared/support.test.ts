import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { setHostEmailConfigForTest } from "#shared/email.ts";
import {
  getSupportPageText,
  isSupportEnabled,
  isSupportFormActive,
  sendSupportMessage,
  supportNagFor,
  supportNagLabel,
  supportSubject,
} from "#shared/support.ts";
import { emailTestSandbox, expectSendNoop, validEmail } from "#test-utils";

const ADMIN_ENV = { ADMIN_EMAIL_ADDRESS: "host@support.test" };

describe("support feature availability", () => {
  const sandbox = emailTestSandbox();

  afterEach(sandbox.teardown);

  test("isSupportEnabled is false when ADMIN_EMAIL_ADDRESS is unset", () => {
    sandbox.setEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    expect(isSupportEnabled()).toBe(false);
  });

  test("isSupportEnabled is false when ADMIN_EMAIL_ADDRESS is invalid", () => {
    sandbox.setEnv({ ADMIN_EMAIL_ADDRESS: "not-an-email" });
    expect(isSupportEnabled()).toBe(false);
  });

  test("isSupportEnabled is true when ADMIN_EMAIL_ADDRESS is valid", () => {
    sandbox.setEnv(ADMIN_ENV);
    expect(isSupportEnabled()).toBe(true);
  });

  test("isSupportFormActive is false when the feature is disabled", () => {
    sandbox.setEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    settings.setForTest({ business_email: "owner@example.com" });
    expect(isSupportFormActive()).toBe(false);
  });

  test("isSupportFormActive is false when enabled with no business email", () => {
    sandbox.setEnv(ADMIN_ENV);
    settings.setForTest({ business_email: "" });
    expect(isSupportFormActive()).toBe(false);
  });

  test("isSupportFormActive is true when enabled with a business email", () => {
    sandbox.setEnv(ADMIN_ENV);
    settings.setForTest({ business_email: "owner@example.com" });
    expect(isSupportFormActive()).toBe(true);
  });
});

describe("getSupportPageText", () => {
  const sandbox = emailTestSandbox();

  afterEach(sandbox.teardown);

  test("returns null when unset", () => {
    sandbox.setEnv({ SUPPORT_PAGE_TEXT: undefined });
    expect(getSupportPageText()).toBeNull();
  });

  test("returns null when blank", () => {
    sandbox.setEnv({ SUPPORT_PAGE_TEXT: "   " });
    expect(getSupportPageText()).toBeNull();
  });

  test("returns the markdown when set", () => {
    sandbox.setEnv({ SUPPORT_PAGE_TEXT: "# Help\n\nContact us" });
    expect(getSupportPageText()).toBe("# Help\n\nContact us");
  });

  test("converts literal backslash-n sequences into real newlines", () => {
    sandbox.setEnv({ SUPPORT_PAGE_TEXT: "Line one\\nLine two" });
    expect(getSupportPageText()).toBe("Line one\nLine two");
  });
});

describe("supportSubject", () => {
  test("identifies the originating site", () => {
    expect(supportSubject("tickets.example.com")).toBe(
      "Support message from Chobble Tickets site tickets.example.com",
    );
  });
});

describe("supportNagFor", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");

  test("returns null when there is no prior submission", () => {
    expect(supportNagFor(null, now, 7)).toBeNull();
  });

  test("returns null for an unparseable timestamp", () => {
    expect(supportNagFor("nonsense", now, 7)).toBeNull();
  });

  test("returns null for a future timestamp", () => {
    expect(supportNagFor("2026-06-16T12:00:00.000Z", now, 7)).toBeNull();
  });

  test("returns the time-ago label inside the window", () => {
    expect(supportNagFor("2026-06-13T12:00:00.000Z", now, 7)).toBe(
      "2 days ago",
    );
  });

  test("includes the exact window boundary", () => {
    expect(supportNagFor("2026-06-08T12:00:00.000Z", now, 7)).toBe(
      "7 days ago",
    );
  });

  test("returns null once the window has passed", () => {
    expect(supportNagFor("2026-06-01T12:00:00.000Z", now, 7)).toBeNull();
  });
});

describe("supportNagLabel", () => {
  afterEach(() => settings.clearTestOverrides());

  test("returns null when the form was never submitted", () => {
    settings.setForTest({ support_form_last_submitted: "" });
    expect(supportNagLabel()).toBeNull();
  });

  test("nags about a recent submission", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    settings.setForTest({ support_form_last_submitted: twoHoursAgo });
    expect(supportNagLabel()).toBe("2 hours ago");
  });

  test("does not nag once the default window has passed", () => {
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    settings.setForTest({ support_form_last_submitted: longAgo });
    expect(supportNagLabel()).toBeNull();
  });
});

describe("sendSupportMessage", () => {
  const sandbox = emailTestSandbox();

  beforeEach(() => {
    sandbox.setEnv(ADMIN_ENV);
    settings.setForTest({ business_email: "owner@example.com" });
    setHostEmailConfigForTest({
      apiKey: "host-key",
      fromAddress: validEmail("sender@sending.test"),
      provider: "resend",
    });
    setEffectiveDomainForTest("tickets.example.com");
  });

  afterEach(sandbox.teardown);

  test("returns false and sends nothing when ADMIN_EMAIL_ADDRESS is unset", async () => {
    sandbox.setEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    await expectSendNoop(sandbox, () => sendSupportMessage("Help"));
  });

  test("returns false and sends nothing when no business email is set", async () => {
    settings.setForTest({ business_email: "" });
    await expectSendNoop(sandbox, () => sendSupportMessage("Help"));
  });

  test("returns false when no email provider is configured", async () => {
    setHostEmailConfigForTest(null);
    await expectSendNoop(sandbox, () => sendSupportMessage("Help"));
  });

  test("delivers to the admin address, from the site's business email", async () => {
    const captured = sandbox.captureFetchCall();

    const result = await sendSupportMessage("Please help");

    expect(result).toBe(true);
    expect(captured.url).toBe("https://api.resend.com/emails");
    // Recipient is the host; envelope from is the host's address; the site's
    // business email is the Reply-To and the displayed "From:".
    expect(captured.body.to).toEqual(["host@support.test"]);
    expect(captured.body.from).toBe("sender@sending.test");
    expect(captured.body.reply_to).toBe("owner@example.com");
    expect(captured.body.subject).toBe(
      "Support message from Chobble Tickets site tickets.example.com",
    );
    expect(String(captured.body.text)).toContain("Please help");
    expect(String(captured.body.text)).toContain("tickets.example.com");
    expect(String(captured.body.html)).toContain("owner@example.com");
  });

  test("returns false when the email provider responds with an error", async () => {
    sandbox.stubFetch(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    expect(await sendSupportMessage("Help")).toBe(false);
  });
});
