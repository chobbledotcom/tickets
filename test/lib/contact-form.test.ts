import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import {
  contactFormPublicKey,
  isContactFormActive,
  isContactFormAvailable,
  sendContactMessage,
} from "#shared/contact-form.ts";
import { settings } from "#shared/db/settings.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import { setTestEnv } from "#test-utils";

const BOTH_KEYS = {
  BOTPOISON_PUBLIC_KEY: "pk_test_public",
  BOTPOISON_SECRET_KEY: "sk_test_secret",
};

const NO_KEYS = {
  BOTPOISON_PUBLIC_KEY: undefined,
  BOTPOISON_SECRET_KEY: undefined,
};

describe("contact form availability", () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
    settings.clearTestOverrides();
  });

  test("isContactFormAvailable is true when both Botpoison keys are set", () => {
    restoreEnv = setTestEnv(BOTH_KEYS);
    expect(isContactFormAvailable()).toBe(true);
  });

  test("isContactFormAvailable is false without Botpoison keys", () => {
    restoreEnv = setTestEnv(NO_KEYS);
    expect(isContactFormAvailable()).toBe(false);
  });

  test("contactFormPublicKey returns the public env key", () => {
    restoreEnv = setTestEnv(BOTH_KEYS);
    expect(contactFormPublicKey()).toBe("pk_test_public");
  });

  test("isContactFormActive needs keys, toggle on, and a business email", () => {
    restoreEnv = setTestEnv(BOTH_KEYS);
    settings.setForTest({
      business_email: "owner@example.com",
      contact_form_enabled: true,
    });
    expect(isContactFormActive()).toBe(true);
  });

  test("isContactFormActive is false when Botpoison is not configured", () => {
    restoreEnv = setTestEnv(NO_KEYS);
    settings.setForTest({
      business_email: "owner@example.com",
      contact_form_enabled: true,
    });
    expect(isContactFormActive()).toBe(false);
  });

  test("isContactFormActive is false when the toggle is off", () => {
    restoreEnv = setTestEnv(BOTH_KEYS);
    settings.setForTest({
      business_email: "owner@example.com",
      contact_form_enabled: false,
    });
    expect(isContactFormActive()).toBe(false);
  });

  test("isContactFormActive is false when no business email is set", () => {
    restoreEnv = setTestEnv(BOTH_KEYS);
    settings.setForTest({
      business_email: "",
      contact_form_enabled: true,
    });
    expect(isContactFormActive()).toBe(false);
  });
});

describe("sendContactMessage", () => {
  let restoreEnv: (() => void) | undefined;
  let fetchStub: Stub | undefined;

  beforeEach(() => {
    restoreEnv = setTestEnv(BOTH_KEYS);
    setHostEmailConfigForTest(null);
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

  const configureEmail = (): void => {
    settings.setForTest({
      business_email: "owner@example.com",
      email_api_key: "re_test_key",
      email_provider: "resend",
    });
  };

  test("returns false and sends nothing when no email provider is set", async () => {
    settings.setForTest({ business_email: "owner@example.com" });
    stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(await sendContactMessage("visitor@example.com", "Hi")).toBe(false);
    expect(fetchStub?.calls.length).toBe(0);
  });

  test("returns false when no business email is set", async () => {
    settings.setForTest({
      business_email: "",
      email_api_key: "re_test_key",
      email_from_address: "sender@example.com",
      email_provider: "resend",
    });
    stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(await sendContactMessage("visitor@example.com", "Hi")).toBe(false);
    expect(fetchStub?.calls.length).toBe(0);
  });

  test("delivers to the business email with the sender as Reply-To", async () => {
    configureEmail();
    const captured = { body: {} as Record<string, unknown>, url: "" };
    stubFetch((url, init) => {
      captured.url = url;
      captured.body = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const result = await sendContactMessage(
      "visitor@example.com",
      "Hello there",
    );

    expect(result).toBe(true);
    expect(captured.url).toBe("https://api.resend.com/emails");
    expect(captured.body.to).toEqual(["owner@example.com"]);
    expect(captured.body.reply_to).toBe("visitor@example.com");
    expect(String(captured.body.text)).toContain("Hello there");
    expect(String(captured.body.text)).toContain("tickets.example.com");
    expect(String(captured.body.html)).toContain("Hello there");
  });

  test("returns false when the email provider responds with an error", async () => {
    configureEmail();
    stubFetch(() => Promise.resolve(new Response("nope", { status: 422 })));
    expect(await sendContactMessage("visitor@example.com", "Hi")).toBe(false);
  });

  test("escapes HTML in the message body", async () => {
    configureEmail();
    const captured = { body: {} as Record<string, unknown> };
    stubFetch((_url, init) => {
      captured.body = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await sendContactMessage("visitor@example.com", "<script>x</script>");

    expect(String(captured.body.html)).not.toContain("<script>x</script>");
    expect(String(captured.body.html)).toContain("&lt;script&gt;");
  });
});
