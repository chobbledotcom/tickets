import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { EmailConfig, EmailMessage } from "#lib/email.ts";
import { sendEmail } from "#lib/email.ts";
import {
  collectErrorLogs,
  expectEmailSendLog,
  useFetchStub,
  withErrorSpy,
} from "../email/_fetch-helpers.ts";

const testConfig: EmailConfig = {
  provider: "resend",
  apiKey: "re_test_key",
  fromAddress: "tickets@example.com",
};

const minimalMsg: EmailMessage = {
  to: "a@b.com",
  subject: "s",
  html: "h",
  text: "t",
};

const sendWithProvider = (
  provider: EmailConfig["provider"],
  msg: EmailMessage = minimalMsg,
) => sendEmail({ ...testConfig, provider }, msg);

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

describe("sendEmail", () => {
  const fetch = useFetchStub();
  const mailgunBasicAuth = `Basic ${btoa("api:re_test_key")}`;

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
    expect(fetch.callCount()).toBe(1);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.resend.com/emails");
    expect(fetch.getFetchHeaders().Authorization).toBe("Bearer re_test_key");
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
      to: "user@test.com",
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(fetch.getFetchHeaders()["X-Postmark-Server-Token"]).toBe(
      "re_test_key",
    );
    const body = fetch.getFetchJsonBody();
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
      to: "user@test.com",
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(fetch.getFetchJsonBody().reply_to).toBeUndefined();
  });

  test("sends via Mailgun (US) with correct URL, headers, and FormData body", async () => {
    await sendWithProvider("mailgun-us", {
      to: "user@test.com",
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
      replyTo: "reply@test.com",
    });

    expect(fetch.callCount()).toBe(1);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.mailgun.net/v3/example.com/messages");
    expect(fetch.getFetchHeaders().Authorization).toBe(mailgunBasicAuth);
    expect(fetch.getFetchHeaders()).not.toHaveProperty("Content-Type");
    const body = fetch.getFetchFormBody();
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

    expect(fetch.callCount()).toBe(1);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.eu.mailgun.net/v3/example.com/messages");
    expect(fetch.getFetchHeaders().Authorization).toBe(mailgunBasicAuth);
    const body = fetch.getFetchFormBody();
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

    expect(fetch.getFetchFormBody().get("h:Reply-To")).toBeNull();
  });

  test("returns status code on non-OK response", async () => {
    fetch.restubFetch(() =>
      Promise.resolve(new Response("Error", { status: 500 })),
    );

    await sendEmailExpectingError(testConfig, minimalMsg, 500, "status=500");
  });

  test("returns undefined on fetch failure", async () => {
    fetch.restubFetch(() => Promise.reject(new Error("Network error")));

    await sendEmailExpectingError(
      testConfig,
      minimalMsg,
      undefined,
      "Network error",
    );
  });

  test("returns undefined for non-Error thrown values", async () => {
    fetch.restubFetch(() => Promise.reject("string error"));

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
  const fetch = useFetchStub();

  const attachment = {
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

    expect(fetch.getFetchJsonBody().attachments).toEqual([
      { filename: "ticket.svg", content: attachment.content },
    ]);
  });

  test("Postmark includes Attachments with Name, Content, ContentType", async () => {
    await sendWithProvider("postmark", msgWithAttachment);

    expect(fetch.getFetchJsonBody().Attachments).toEqual([
      {
        Name: "ticket.svg",
        Content: attachment.content,
        ContentType: "image/svg+xml",
      },
    ]);
  });

  test("SendGrid includes attachments with content, filename, type, disposition", async () => {
    await sendWithProvider("sendgrid", msgWithAttachment);

    expect(fetch.getFetchJsonBody().attachments).toEqual([
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

    const body = fetch.getFetchFormBody();
    const file = body.get("attachment") as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("ticket.svg");
    expect(file.type).toBe("image/svg+xml");
  });

  test("omits attachments field when no attachments provided", async () => {
    await sendEmail(testConfig, minimalMsg);

    expect(fetch.getFetchJsonBody().attachments).toBeUndefined();
  });
});
