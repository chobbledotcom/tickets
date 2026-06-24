import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import {
  contactFormPublicKey,
  isContactFormActive,
  sendContactMessage,
} from "#shared/contact-form.ts";
import { settings } from "#shared/db/settings.ts";
import { setHostEmailConfigForTest } from "#shared/email.ts";
import { emailTestSandbox, validEmail } from "#test-utils";

const BOTH_KEYS = {
  BOTPOISON_PUBLIC_KEY: "pk_test_public",
  BOTPOISON_SECRET_KEY: "sk_test_secret",
};

const NO_KEYS = {
  BOTPOISON_PUBLIC_KEY: undefined,
  BOTPOISON_SECRET_KEY: undefined,
};

describe("contact form availability", () => {
  const sandbox = emailTestSandbox();

  afterEach(sandbox.teardown);

  test("isContactFormActive is true with the toggle on and a business email", () => {
    settings.setForTest({
      business_email: "owner@example.com",
      contact_form_enabled: true,
    });
    expect(isContactFormActive()).toBe(true);
  });

  test("isContactFormActive does not require Botpoison", () => {
    sandbox.setEnv(NO_KEYS);
    settings.setForTest({
      business_email: "owner@example.com",
      contact_form_enabled: true,
    });
    expect(isContactFormActive()).toBe(true);
  });

  test("isContactFormActive is false when the toggle is off", () => {
    settings.setForTest({
      business_email: "owner@example.com",
      contact_form_enabled: false,
    });
    expect(isContactFormActive()).toBe(false);
  });

  test("isContactFormActive is false when no business email is set", () => {
    settings.setForTest({
      business_email: "",
      contact_form_enabled: true,
    });
    expect(isContactFormActive()).toBe(false);
  });

  test("contactFormPublicKey returns the public env key when set", () => {
    sandbox.setEnv(BOTH_KEYS);
    expect(contactFormPublicKey()).toBe("pk_test_public");
  });

  test("contactFormPublicKey is empty when Botpoison is not configured", () => {
    sandbox.setEnv(NO_KEYS);
    expect(contactFormPublicKey()).toBe("");
  });
});

describe("sendContactMessage", () => {
  const sandbox = emailTestSandbox();

  beforeEach(() => {
    sandbox.setEnv(BOTH_KEYS);
    setHostEmailConfigForTest(null);
    setEffectiveDomainForTest("tickets.example.com");
  });

  afterEach(sandbox.teardown);

  const configureEmail = (): void => {
    settings.setForTest({
      business_email: "owner@example.com",
      email_api_key: "re_test_key",
      email_provider: "resend",
    });
  };

  test("returns false and sends nothing when no email provider is set", async () => {
    settings.setForTest({ business_email: "owner@example.com" });
    sandbox.stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(
      await sendContactMessage(validEmail("visitor@example.com"), "Hi"),
    ).toBe(false);
    expect(sandbox.fetchStub?.calls.length).toBe(0);
  });

  test("returns false when no business email is set", async () => {
    settings.setForTest({
      business_email: "",
      email_api_key: "re_test_key",
      email_from_address: "sender@example.com",
      email_provider: "resend",
    });
    sandbox.stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(
      await sendContactMessage(validEmail("visitor@example.com"), "Hi"),
    ).toBe(false);
    expect(sandbox.fetchStub?.calls.length).toBe(0);
  });

  test("delivers to the business email with the sender as Reply-To", async () => {
    configureEmail();
    const captured = sandbox.captureFetchCall();

    const result = await sendContactMessage(
      validEmail("visitor@external.test"),
      "Hello there",
    );

    expect(result).toBe(true);
    expect(captured.url).toBe("https://api.resend.com/emails");
    expect(captured.body.to).toEqual(["owner@example.com"]);
    expect(captured.body.reply_to).toBe("visitor@external.test");
    expect(String(captured.body.text)).toContain("Hello there");
    expect(String(captured.body.text)).toContain("tickets.example.com");
    expect(String(captured.body.html)).toContain("Hello there");
    expect(String(captured.body.html)).not.toContain("spoof");
  });

  test("warns about spoofing the owner when the submitter shares the business email host", async () => {
    settings.setForTest({
      business_email: "owner@example.com",
      email_api_key: "re_test_key",
      email_from_address: "sender@sending.test",
      email_provider: "resend",
    });
    const captured = sandbox.captureFetchCall();

    const result = await sendContactMessage(
      validEmail("imposter@example.com"),
      "Hi me",
    );

    expect(result).toBe(true);
    expect(captured.body.reply_to).toBe("sender@sending.test");
    expect(String(captured.body.html)).toContain("spoof you");
    expect(String(captured.body.text)).toContain("spoof you");
  });

  test("warns about spoofing the host when the submitter shares the sending email host", async () => {
    settings.setForTest({
      business_email: "owner@business.test",
      email_api_key: "re_test_key",
      email_from_address: "sender@sending.test",
      email_provider: "resend",
    });
    const captured = sandbox.captureFetchCall();

    const result = await sendContactMessage(
      validEmail("imposter@sending.test"),
      "Hi",
    );

    expect(result).toBe(true);
    expect(captured.body.reply_to).toBe("sender@sending.test");
    expect(String(captured.body.html)).toContain("spoof the host");
    expect(String(captured.body.text)).toContain("spoof the host");
  });

  test("returns false when the email provider responds with an error", async () => {
    configureEmail();
    sandbox.stubFetch(() =>
      Promise.resolve(new Response("nope", { status: 422 })),
    );
    expect(
      await sendContactMessage(validEmail("visitor@example.com"), "Hi"),
    ).toBe(false);
  });

  test("escapes HTML in the message body", async () => {
    configureEmail();
    const captured = sandbox.captureFetchCall();

    await sendContactMessage(
      validEmail("visitor@example.com"),
      "<script>x</script>",
    );

    expect(String(captured.body.html)).not.toContain("<script>x</script>");
    expect(String(captured.body.html)).toContain("&lt;script&gt;");
  });
});
