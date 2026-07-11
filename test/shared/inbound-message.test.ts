/**
 * The shared pieces of the "send us a message" email forms: the message-field
 * validator, the HTML/plain-text notification body builders, provider
 * resolution, and the low-level send.
 *
 * The builders lock the free-text length rule, the exact body layout, and —
 * most importantly — that every caller-supplied value is HTML-escaped in the
 * HTML body so a submitted message can't inject markup into the notification
 * email. The IO helpers lock the provider fallback (settings → host env, with a
 * logged miss) and that a send is judged delivered only on a 2xx response.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { type EmailConfig, setHostEmailConfigForTest } from "#shared/email.ts";
import {
  buildMessageHtml,
  buildMessageText,
  deliverMessage,
  MESSAGE_SEND_FAILED,
  resolveMessageEmailConfig,
  validateMessageText,
} from "#shared/inbound-message.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { emailTestSandbox, validEmail } from "#test-utils/email.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describe("inbound-message", () => {
  test("MESSAGE_SEND_FAILED is the submitter-facing failure copy", () => {
    expect(MESSAGE_SEND_FAILED).toBe(
      "Sorry, your message could not be sent. Please try again later.",
    );
  });

  describe("validateMessageText", () => {
    test("rejects an empty message", () => {
      expect(validateMessageText("")).toBe("Please enter a message.");
    });

    test("accepts a normal message", () => {
      expect(validateMessageText("Hello there")).toBeNull();
    });

    test("accepts a message exactly at the length limit", () => {
      expect(validateMessageText("a".repeat(MAX_TEXTAREA_LENGTH))).toBeNull();
    });

    test("rejects a message one character over the limit", () => {
      expect(validateMessageText("a".repeat(MAX_TEXTAREA_LENGTH + 1))).toBe(
        `Message must be ${MAX_TEXTAREA_LENGTH} characters or fewer.`,
      );
    });
  });

  describe("buildMessageHtml", () => {
    test("lays out intro, from, and message with no warning", () => {
      const html = buildMessageHtml(
        { fromLabel: "a@b.com", message: "hello", warning: null },
        "New message",
      );
      expect(html).toBe(
        "<p>New message</p>" +
          "<p><strong>From:</strong> a@b.com</p>" +
          "<p><strong>Message:</strong></p><p>hello</p>",
      );
    });

    test("prepends a bold warning when one is given", () => {
      const html = buildMessageHtml(
        { fromLabel: "a@b.com", message: "hello", warning: "Heads up" },
        "New message",
      );
      expect(html.startsWith("<p><strong>Heads up</strong></p>")).toBe(true);
    });

    test("turns newlines in the message into <br>", () => {
      const html = buildMessageHtml(
        { fromLabel: "a@b.com", message: "line1\nline2", warning: null },
        "New message",
      );
      expect(html).toContain("<p>line1<br>line2</p>");
    });

    test("HTML-escapes the intro, from label, message, and warning", () => {
      const html = buildMessageHtml(
        { fromLabel: "<a>", message: '1 < 2 & "q"', warning: "<b>" },
        "in<ro",
      );
      expect(html).toBe(
        "<p><strong>&lt;b&gt;</strong></p>" +
          "<p>in&lt;ro</p>" +
          "<p><strong>From:</strong> &lt;a&gt;</p>" +
          "<p><strong>Message:</strong></p><p>1 &lt; 2 &amp; &quot;q&quot;</p>",
      );
    });
  });

  describe("buildMessageText", () => {
    test("lays out intro, from, and message with no warning", () => {
      const text = buildMessageText(
        { fromLabel: "a@b.com", message: "hello", warning: null },
        "New message",
      );
      expect(text).toBe("New message\n\nFrom: a@b.com\n\nMessage:\nhello");
    });

    test("prepends the warning followed by a blank line", () => {
      const text = buildMessageText(
        { fromLabel: "a@b.com", message: "hello", warning: "Heads up" },
        "New message",
      );
      expect(text).toBe(
        "Heads up\n\nNew message\n\nFrom: a@b.com\n\nMessage:\nhello",
      );
    });

    test("leaves the plain-text body unescaped", () => {
      const text = buildMessageText(
        { fromLabel: "<a>", message: "1 < 2", warning: null },
        "intro",
      );
      expect(text).toBe("intro\n\nFrom: <a>\n\nMessage:\n1 < 2");
    });
  });

  describe("resolveMessageEmailConfig", () => {
    const sandbox = emailTestSandbox();
    const errors = setupErrorSpy();
    afterEach(sandbox.teardown);

    test("falls back to the host provider config when settings has none", async () => {
      const hostConfig: EmailConfig = {
        apiKey: "host-key",
        fromAddress: validEmail("sender@sending.test"),
        provider: "resend",
      };
      setHostEmailConfigForTest(hostConfig);
      expect(await resolveMessageEmailConfig()).toEqual(hostConfig);
      // The "no provider" miss must not be logged when one was resolved.
      expect(errors.contains("no email provider configured")).toBe(false);
    });

    test("returns null and logs the miss when no provider is configured", async () => {
      settings.setForTest({ email_provider: "" });
      setHostEmailConfigForTest(null);
      expect(await resolveMessageEmailConfig()).toBeNull();
      expect(
        errors.contains("message form: no email provider configured"),
      ).toBe(true);
    });
  });

  describe("deliverMessage", () => {
    const sandbox = emailTestSandbox();
    afterEach(sandbox.teardown);

    const config: EmailConfig = {
      apiKey: "key",
      fromAddress: validEmail("sender@sending.test"),
      provider: "resend",
    };
    const opts = () => ({
      body: {
        fromLabel: "visitor@example.com",
        message: "Hello",
        warning: null,
      },
      intro: "New message",
      subject: "A subject",
      to: validEmail("dest@example.com"),
    });

    test("sends the built bodies and returns true on a 2xx response", async () => {
      const captured = sandbox.captureFetchCall(200);
      expect(await deliverMessage(config, opts())).toBe(true);
      expect(captured.url).toBe("https://api.resend.com/emails");
      expect(captured.body.to).toEqual(["dest@example.com"]);
      expect(String(captured.body.html)).toContain(
        "<strong>From:</strong> visitor@example.com",
      );
      expect(String(captured.body.text)).toContain("From: visitor@example.com");
    });

    test("returns false when the provider responds with a 5xx error", async () => {
      sandbox.stubFetch(() =>
        Promise.resolve(new Response("nope", { status: 500 })),
      );
      expect(await deliverMessage(config, opts())).toBe(false);
    });
  });
});
