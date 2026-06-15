import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import {
  getSupportPageText,
  isSupportEnabled,
  isSupportFormActive,
  sendSupportMessage,
  supportNagFor,
  supportNagLabel,
  supportSubject,
} from "#shared/support.ts";
import { setTestEnv, validEmail } from "#test-utils";

const ADMIN_ENV = { ADMIN_EMAIL_ADDRESS: "host@support.test" };

describe("support feature availability", () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
    settings.clearTestOverrides();
  });

  test("isSupportEnabled is false when ADMIN_EMAIL_ADDRESS is unset", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    expect(isSupportEnabled()).toBe(false);
  });

  test("isSupportEnabled is false when ADMIN_EMAIL_ADDRESS is invalid", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "not-an-email" });
    expect(isSupportEnabled()).toBe(false);
  });

  test("isSupportEnabled is true when ADMIN_EMAIL_ADDRESS is valid", () => {
    restoreEnv = setTestEnv(ADMIN_ENV);
    expect(isSupportEnabled()).toBe(true);
  });

  test("isSupportFormActive is false when the feature is disabled", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    settings.setForTest({ business_email: "owner@example.com" });
    expect(isSupportFormActive()).toBe(false);
  });

  test("isSupportFormActive is false when enabled with no business email", () => {
    restoreEnv = setTestEnv(ADMIN_ENV);
    settings.setForTest({ business_email: "" });
    expect(isSupportFormActive()).toBe(false);
  });

  test("isSupportFormActive is true when enabled with a business email", () => {
    restoreEnv = setTestEnv(ADMIN_ENV);
    settings.setForTest({ business_email: "owner@example.com" });
    expect(isSupportFormActive()).toBe(true);
  });
});

describe("getSupportPageText", () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });

  test("returns null when unset", () => {
    restoreEnv = setTestEnv({ SUPPORT_PAGE_TEXT: undefined });
    expect(getSupportPageText()).toBeNull();
  });

  test("returns null when blank", () => {
    restoreEnv = setTestEnv({ SUPPORT_PAGE_TEXT: "   " });
    expect(getSupportPageText()).toBeNull();
  });

  test("returns the markdown when set", () => {
    restoreEnv = setTestEnv({ SUPPORT_PAGE_TEXT: "# Help\n\nContact us" });
    expect(getSupportPageText()).toBe("# Help\n\nContact us");
  });

  test("converts literal backslash-n sequences into real newlines", () => {
    restoreEnv = setTestEnv({ SUPPORT_PAGE_TEXT: "Line one\\nLine two" });
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
  let restoreEnv: (() => void) | undefined;
  let fetchStub: Stub | undefined;

  beforeEach(() => {
    restoreEnv = setTestEnv(ADMIN_ENV);
    settings.setForTest({ business_email: "owner@example.com" });
    setHostEmailConfigForTest({
      apiKey: "host-key",
      fromAddress: validEmail("sender@sending.test"),
      provider: "resend",
    });
    setEffectiveDomainForTest("tickets.example.com");
  });

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = undefined;
    resetHostEmailConfig();
    resetEffectiveDomain();
    settings.clearTestOverrides();
    restoreEnv?.();
    restoreEnv = undefined;
  });

  const stubFetch = (
    impl: (url: string, init?: RequestInit) => Promise<Response>,
  ): void => {
    fetchStub = stub(
      globalThis,
      "fetch",
      impl as unknown as typeof globalThis.fetch,
    );
  };

  test("returns false and sends nothing when ADMIN_EMAIL_ADDRESS is unset", async () => {
    restoreEnv?.();
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(await sendSupportMessage("Help")).toBe(false);
    expect(fetchStub?.calls.length).toBe(0);
  });

  test("returns false and sends nothing when no business email is set", async () => {
    settings.setForTest({ business_email: "" });
    stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(await sendSupportMessage("Help")).toBe(false);
    expect(fetchStub?.calls.length).toBe(0);
  });

  test("returns false when no email provider is configured", async () => {
    setHostEmailConfigForTest(null);
    stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(await sendSupportMessage("Help")).toBe(false);
    expect(fetchStub?.calls.length).toBe(0);
  });

  test("delivers to the admin address, from the site's business email", async () => {
    const captured = { body: {} as Record<string, unknown>, url: "" };
    stubFetch((url, init) => {
      captured.url = url;
      captured.body = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(null, { status: 200 }));
    });

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
    stubFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    expect(await sendSupportMessage("Help")).toBe(false);
  });
});
