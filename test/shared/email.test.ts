import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { t } from "#i18n";
import {
  deliverRegistrationEmail,
  EMAIL_PROVIDER_LABELS,
  type EmailConfig,
  type EmailMessage,
  sendEmail,
  sendTestEmail,
} from "#shared/email.ts";
import {
  minimalEmailMessage,
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

const sendWithProvider = (
  provider: EmailConfig["provider"],
  msg: EmailMessage = minimalEmailMessage,
) => sendEmail({ ...testEmailConfig, provider }, msg);

type ExpectedFailure = {
  /** Substring the E_EMAIL_SEND log line must carry — pass the whole
   * `detail="…"` fragment to pin the exact detail. */
  logged: string;
  /** The operator-facing reason, asserted exactly when given. */
  reason?: string;
  status: number | undefined;
};

const sendEmailExpectingError = async (
  config: EmailConfig,
  msg: EmailMessage,
  expected: ExpectedFailure,
): Promise<void> => {
  const errorSpy = spy(console, "error");
  try {
    const delivery = await sendEmail(config, msg);
    expect(delivery.delivered).toBe(false);
    if (delivery.delivered) return;
    expect(delivery.status).toBe(expected.status);
    if (expected.reason !== undefined) {
      expect(delivery.reason).toBe(expected.reason);
    }
    const logs = errorSpy.calls.map((c) => c.args[0] as string);
    expect(logs.join("\n")).not.toContain(msg.to);
    expect(
      logs.some(
        (l) => l.includes("E_EMAIL_SEND") && l.includes(expected.logged),
      ),
    ).toBe(true);
  } finally {
    errorSpy.restore();
  }
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
    expect(fetch.getFetchHeaders().Accept).toBe("application/json");
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

  const restubReply = (body: string | null, status: number): void =>
    fetch.restubFetch(() => Promise.resolve(new Response(body, { status })));

  test("logs the provider's reply body on a non-OK response", async () => {
    restubReply("Error", 500);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=500: Error"',
      reason: "Error",
      status: 500,
    });
  });

  test("logs SendGrid's message from its errors array", async () => {
    const message =
      "The from address does not match a verified Sender Identity";
    restubReply(
      JSON.stringify({ errors: [{ field: "from", help: null, message }] }),
      403,
    );

    await sendEmailExpectingError(
      { ...testEmailConfig, provider: "sendgrid" },
      minimalEmailMessage,
      {
        logged: `detail="provider=sendgrid status=403: ${message}"`,
        reason: message,
        status: 403,
      },
    );
  });

  test("reads a plain error key in a reply", async () => {
    restubReply('{"error":"Invalid API key"}', 401);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=401: Invalid API key"',
      reason: "Invalid API key",
      status: 401,
    });
  });

  test("reads Postmark's capitalised Message key", async () => {
    restubReply('{"ErrorCode":10,"Message":"Bad API token"}', 401);

    await sendEmailExpectingError(
      { ...testEmailConfig, provider: "postmark" },
      minimalEmailMessage,
      {
        logged: 'detail="provider=postmark status=401: Bad API token"',
        status: 401,
      },
    );
  });

  test("scrubs the send's own addresses from the reason", async () => {
    restubReply(
      '{"message":"a@b.com reply@test.com and tickets@example.com are not allowed"}',
      400,
    );

    await sendEmailExpectingError(
      testEmailConfig,
      { ...minimalEmailMessage, replyTo: validEmail("reply@test.com") },
      {
        logged:
          'detail="provider=resend status=400: [redacted] [redacted] and [redacted] are not allowed"',
        status: 400,
      },
    );
  });

  test("scrubs an address the send never named", async () => {
    restubReply(
      '{"message":"You can only send testing emails to your own email address (owner@gmail.com)"}',
      403,
    );

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged:
        'detail="provider=resend status=403: You can only send testing emails to your own email address [redacted]"',
      reason:
        "You can only send testing emails to your own email address [redacted]",
      status: 403,
    });
  });

  test("scrubs the configured from address on an unverified-sender reply", async () => {
    restubReply(
      '{"errors":[{"message":"The from address tickets@example.com is not a verified Sender Identity"}]}',
      403,
    );

    await sendEmailExpectingError(
      { ...testEmailConfig, provider: "sendgrid" },
      minimalEmailMessage,
      {
        logged:
          'detail="provider=sendgrid status=403: The from address [redacted] is not a verified Sender Identity"',
        reason: "The from address [redacted] is not a verified Sender Identity",
        status: 403,
      },
    );
  });

  test("puts a multi-line reply onto one log line", async () => {
    restubReply("Access\n\n  denied", 403);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=403: Access denied"',
      reason: "Access denied",
      status: 403,
    });
  });

  test("caps an over-long reply", async () => {
    restubReply("x".repeat(1000), 500);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: `detail="provider=resend status=500: ${"x".repeat(300)}..."`,
      reason: `${"x".repeat(300)}...`,
      status: 500,
    });
  });

  test("keeps a reply exactly at the cap whole", async () => {
    restubReply("y".repeat(300), 500);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: `detail="provider=resend status=500: ${"y".repeat(300)}"`,
      status: 500,
    });
  });

  test("logs only provider and status when the reply body is empty", async () => {
    restubReply(null, 500);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=500"',
      reason: "",
      status: 500,
    });
  });

  test("returns no status on fetch failure", async () => {
    fetch.restubFetch(() => Promise.reject(new Error("Network error")));

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="Network error"',
      reason: "",
      status: undefined,
    });
  });

  test("returns no status for non-Error thrown values", async () => {
    fetch.restubFetch(() => Promise.reject("string error"));

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="string error"',
      status: undefined,
    });
  });

  test("registration delivery returns network failures", async () => {
    fetch.restubFetch(() => Promise.reject(new TypeError("Network error")));

    expect(
      await deliverRegistrationEmail(testEmailConfig, minimalEmailMessage),
    ).toEqual({
      delivered: false,
      detail: "Network error",
      reason: "",
      status: undefined,
    });
  });

  test("registration delivery throws internal failures", async () => {
    const failure = new Error("Internal error");
    fetch.restubFetch(() => Promise.reject(failure));

    await expect(
      deliverRegistrationEmail(testEmailConfig, minimalEmailMessage),
    ).rejects.toBe(failure);
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

describe("sendEmail with attachments", () => {
  const fetch = useFetchStub();

  const attachment = {
    content: btoa("<svg>test</svg>"),
    contentType: "image/svg+xml",
    filename: "ticket.svg",
  };
  const msgWithAttachment: EmailMessage = {
    attachments: [attachment],
    html: "<p>Hi</p>",
    subject: "Tickets",
    text: "Hi",
    to: validEmail("user@test.com"),
  };

  test("Resend includes attachments with filename and content", async () => {
    await sendEmail(testEmailConfig, msgWithAttachment);

    expect(fetch.getFetchJsonBody().attachments).toEqual([
      { content: attachment.content, filename: "ticket.svg" },
    ]);
  });

  test("Postmark includes Attachments with Name, Content, ContentType", async () => {
    await sendWithProvider("postmark", msgWithAttachment);

    expect(fetch.getFetchJsonBody().Attachments).toEqual([
      {
        Content: attachment.content,
        ContentType: "image/svg+xml",
        Name: "ticket.svg",
      },
    ]);
  });

  test("SendGrid includes attachments with content, filename, type, disposition", async () => {
    await sendWithProvider("sendgrid", msgWithAttachment);

    expect(fetch.getFetchJsonBody().attachments).toEqual([
      {
        content: attachment.content,
        disposition: "attachment",
        filename: "ticket.svg",
        type: "image/svg+xml",
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
    await sendEmail(testEmailConfig, minimalEmailMessage);

    expect(fetch.getFetchJsonBody().attachments).toBeUndefined();
  });
});
