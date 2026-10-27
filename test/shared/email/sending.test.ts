import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  EMAIL_PROVIDER_LABELS,
  type EmailMessage,
  sendEmail,
  sendTestEmail,
} from "#shared/email.ts";
import {
  minimalEmailMessage,
  sendWithProvider,
  testEmailConfig,
  validEmail,
} from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";

const plainMsg: EmailMessage = {
  html: "<p>Hi</p>",
  subject: "Test",
  text: "Hi",
  to: validEmail("user@test.com"),
};

describe("sendEmail", () => {
  const fetch = useFetchStub();
  const mailgunBasicAuth = `Basic ${btoa("api:re_test_key")}`;

  const expectMailgunRequest = (expectedUrl: string) => {
    expect(fetch.callCount()).toBe(1);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe(expectedUrl);
    expect(fetch.getFetchHeaders().Authorization).toBe(mailgunBasicAuth);
    const body = fetch.getFetchFormBody();
    expect(body.get("from")).toBe("tickets@example.com");
    expect(body.get("to")).toBe("user@test.com");
    return body;
  };

  test("sends no signal when the caller passes none", async () => {
    await sendEmail(testEmailConfig, minimalEmailMessage);

    const [, init] = fetch.getFetchArgs();
    expect(init?.signal).toBe(null);
  });

  test("carries the caller's signal into the request", async () => {
    const controller = new AbortController();

    await sendEmail(testEmailConfig, minimalEmailMessage, controller.signal);

    const [, init] = fetch.getFetchArgs();
    expect(init?.signal).toBe(controller.signal);
  });

  test("reports a cancelled send as undelivered instead of throwing", async () => {
    const controller = new AbortController();
    fetch.restubFetch((_url, init) => {
      controller.abort();
      return Promise.reject(
        new DOMException(init?.signal?.reason ?? "Aborted", "AbortError"),
      );
    });

    const delivery = await sendEmail(
      testEmailConfig,
      minimalEmailMessage,
      controller.signal,
    );

    expect(delivery.delivered).toBe(false);
  });

  test("sends via Resend with correct URL, headers, and body", async () => {
    const msg: EmailMessage = {
      html: "<p>Hi</p>",
      replyTo: validEmail("reply@test.com"),
      subject: "Test",
      text: "Hi",
      to: validEmail("user@test.com"),
    };

    const delivery = await sendEmail(testEmailConfig, msg);

    expect(delivery).toEqual({ delivered: true, status: 200 });
    expect(fetch.callCount()).toBe(1);
    const [url, init] = fetch.getFetchArgs();
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(fetch.getFetchHeaders().Authorization).toBe("Bearer re_test_key");
    expect(fetch.getFetchHeaders()["Content-Type"]).toBe("application/json");
    const body = fetch.getFetchJsonBody();
    expect(body.from).toBe("tickets@example.com");
    expect(body.to).toEqual(["user@test.com"]);
    expect(body.reply_to).toBe("reply@test.com");
    expect(body.subject).toBe("Test");
    expect(body.html).toBe("<p>Hi</p>");
    expect(body.text).toBe("Hi");
  });

  test("sends via Postmark with correct URL, headers, and body", async () => {
    await sendWithProvider("postmark", {
      html: "<p>Hi</p>",
      subject: "Test",
      text: "Hi",
      to: validEmail("user@test.com"),
    });

    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(fetch.getFetchHeaders()["X-Postmark-Server-Token"]).toBe(
      "re_test_key",
    );
    expect(fetch.getFetchHeaders().Accept).toBe("application/json");
    const body = fetch.getFetchJsonBody();
    expect(body.From).toBe("tickets@example.com");
    expect(body.To).toBe("user@test.com");
    expect(body.Subject).toBe("Test");
    expect(body.HtmlBody).toBe("<p>Hi</p>");
    expect(body.TextBody).toBe("Hi");
  });

  test("sends via SendGrid with correct URL, headers, and body", async () => {
    const msg: EmailMessage = {
      html: "<p>Hi</p>",
      replyTo: validEmail("reply@test.com"),
      subject: "Test",
      text: "Hi",
      to: validEmail("user@test.com"),
    };

    await sendWithProvider("sendgrid", msg);

    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(fetch.getFetchHeaders().Authorization).toBe("Bearer re_test_key");
    const body = fetch.getFetchJsonBody();
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
      html: "<p>Hi</p>",
      subject: "Test",
      text: "Hi",
      to: validEmail("user@test.com"),
    });

    expect(fetch.getFetchJsonBody().reply_to).toBeUndefined();
  });

  test("sends via Mailgun (US) with correct URL, headers, and FormData body", async () => {
    await sendWithProvider("mailgun-us", {
      ...plainMsg,
      replyTo: validEmail("reply@test.com"),
    });

    expect(fetch.getFetchHeaders()).not.toHaveProperty("Content-Type");
    const body = expectMailgunRequest(
      "https://api.mailgun.net/v3/example.com/messages",
    );
    expect(body.get("subject")).toBe("Test");
    expect(body.get("html")).toBe("<p>Hi</p>");
    expect(body.get("text")).toBe("Hi");
    expect(body.get("h:Reply-To")).toBe("reply@test.com");
  });

  test("sends via Mailgun (EU) with EU API endpoint", async () => {
    await sendWithProvider("mailgun-eu", plainMsg);

    expectMailgunRequest("https://api.eu.mailgun.net/v3/example.com/messages");
  });

  test("sends via Mailgun without h:Reply-To when not provided", async () => {
    await sendWithProvider("mailgun-us", {
      html: "<p>Hi</p>",
      subject: "Test",
      text: "Hi",
      to: validEmail("user@test.com"),
    });

    expect(fetch.getFetchFormBody().get("h:Reply-To")).toBeNull();
  });
});

test("email providers have display labels", () => {
  expect(EMAIL_PROVIDER_LABELS).toEqual({
    "mailgun-eu": "Mailgun (EU)",
    "mailgun-us": "Mailgun (US)",
    postmark: "Postmark",
    resend: "Resend",
    sendgrid: "SendGrid",
  });
});

describe("sendTestEmail", () => {
  const fetch = useFetchStub();

  test("sends the translated test message", async () => {
    const delivery = await sendTestEmail(
      testEmailConfig,
      validEmail("admin@test.com"),
    );

    expect(delivery).toEqual({ delivered: true, status: 200 });
    expect(fetch.callCount()).toBe(1);
    const body = fetch.getFetchJsonBody();
    expect(body.to).toEqual(["admin@test.com"]);
    expect(body.html).toBe(`<p>${t("fields.email.test_body")}</p>`);
    expect(body.subject).toBe(t("fields.email.test_subject"));
    expect(body.text).toBe(t("fields.email.test_body"));
  });
});
