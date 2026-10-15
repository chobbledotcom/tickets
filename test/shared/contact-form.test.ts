import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import {
  isContactFormActive,
  sendContactMessage,
} from "#shared/contact-form.ts";
import { hostEmail } from "#shared/email.ts";
import {
  emailTestSandbox,
  expectSendNoop,
  validEmail,
} from "#test-utils/email.ts";

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
});

describe("sendContactMessage", () => {
  const sandbox = emailTestSandbox();

  beforeEach(() => {
    sandbox.setEnv(BOTH_KEYS);
    hostEmail.setOverride(null);
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
    await expectSendNoop(sandbox, () =>
      sendContactMessage(validEmail("visitor@example.com"), "Hi"),
    );
  });

  test("returns false when no business email is set", async () => {
    settings.setForTest({
      business_email: "",
      email_api_key: "re_test_key",
      email_from_address: "sender@example.com",
      email_provider: "resend",
    });
    await expectSendNoop(sandbox, () =>
      sendContactMessage(validEmail("visitor@example.com"), "Hi"),
    );
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
    assertStringIncludes(String(captured.body.text), "Hello there");
    assertStringIncludes(String(captured.body.text), "tickets.example.com");
    assertStringIncludes(String(captured.body.html), "Hello there");
    assert(
      !String(captured.body.html).includes("spoof"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(String(captured.body.html), "spoof you");
    assertStringIncludes(String(captured.body.text), "spoof you");
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
    assertStringIncludes(String(captured.body.html), "spoof the host");
    assertStringIncludes(String(captured.body.text), "spoof the host");
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

    assert(
      !String(captured.body.html).includes("<script>x</script>"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(String(captured.body.html), "&lt;script&gt;");
  });
});
