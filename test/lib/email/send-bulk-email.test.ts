import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  BULK_UNSUBSCRIBE_PLACEHOLDER,
  type BulkEmailPayload,
  type EmailConfig,
  sendBulkEmails,
} from "#shared/email.ts";
import { useFetchStub, validEmail } from "#test-utils";

const config: EmailConfig = {
  apiKey: "re_key",
  fromAddress: validEmail("tickets@example.com"),
  provider: "resend",
};

/** Transactional payload (no unsubscribe placeholder) for n recipients. */
const payload = (n: number): BulkEmailPayload => ({
  html: "<p>Hi</p>",
  recipients: Array.from({ length: n }, (_, i) => ({
    to: validEmail(`user${i}@example.com`),
  })),
  subject: "Hello",
  text: "Hi",
});

/** The stub fetch returns an empty 200, so each batch records this response. */
const okBatch = { body: "", ok: true, status: 200 };

/** Two-recipient payload with the bulk unsubscribe placeholder — used by the
 *  SendGrid and Mailgun personalization tests to check per-recipient
 *  substitution. Both build the same fixture, so it's shared here. */
const twoRecipientUnsubPayload = (): BulkEmailPayload => ({
  html: `<p>Hi</p>${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
  recipients: [
    { to: validEmail("a@example.com"), unsubscribeUrl: "https://x/u/a" },
    { to: validEmail("b@example.com"), unsubscribeUrl: "https://x/u/b" },
  ],
  subject: "Promo",
  text: "Hi",
});

describe("sendBulkEmails", () => {
  const fetch = useFetchStub();

  test("Resend posts one batch request with all recipients", async () => {
    const result = await sendBulkEmails(config, payload(3));

    expect(result).toEqual({
      attempted: 3,
      batches: 1,
      failed: 0,
      responses: [okBatch],
    });
    expect(fetch.callCount()).toBe(1);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.resend.com/emails/batch");
    expect(fetch.getFetchHeaders().Authorization).toBe("Bearer re_key");
    const body = fetch.getFetchJsonBody();
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual({
      from: "tickets@example.com",
      html: "<p>Hi</p>",
      subject: "Hello",
      text: "Hi",
      to: ["user0@example.com"],
    });
  });

  test("Resend substitutes each recipient's unsubscribe URL", async () => {
    await sendBulkEmails(config, {
      html: `<p>Hi</p>${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
      recipients: [
        { to: validEmail("a@example.com"), unsubscribeUrl: "https://x/u/a" },
      ],
      subject: "Promo",
      text: `Hi ${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
    });
    const body = fetch.getFetchJsonBody();
    expect(body[0].html).toBe("<p>Hi</p>https://x/u/a");
    expect(body[0].text).toBe("Hi https://x/u/a");
  });

  test("Resend chunks recipients beyond the 100-per-batch limit", async () => {
    const result = await sendBulkEmails(config, payload(101));

    expect(result).toEqual({
      attempted: 101,
      batches: 2,
      failed: 0,
      responses: [okBatch, okBatch],
    });
    expect(fetch.callCount()).toBe(2);
    expect(fetch.getFetchJsonBody(0)).toHaveLength(100);
    expect(fetch.getFetchJsonBody(1)).toHaveLength(1);
  });

  test("Postmark posts to the batch endpoint with Postmark field names", async () => {
    const result = await sendBulkEmails(
      { ...config, provider: "postmark" },
      payload(2),
    );

    expect(result).toEqual({
      attempted: 2,
      batches: 1,
      failed: 0,
      responses: [okBatch],
    });
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.postmarkapp.com/email/batch");
    expect(fetch.getFetchHeaders()["X-Postmark-Server-Token"]).toBe("re_key");
    const body = fetch.getFetchJsonBody();
    expect(body[0]).toEqual({
      From: "tickets@example.com",
      HtmlBody: "<p>Hi</p>",
      Subject: "Hello",
      TextBody: "Hi",
      To: "user0@example.com",
    });
  });

  test("SendGrid posts one request with a personalization per recipient", async () => {
    await sendBulkEmails(
      { ...config, provider: "sendgrid" },
      twoRecipientUnsubPayload(),
    );

    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    const body = fetch.getFetchJsonBody();
    expect(body.content).toContainEqual({
      type: "text/html",
      value: "<p>Hi</p>-unsub-",
    });
    expect(body.personalizations).toEqual([
      {
        substitutions: { "-unsub-": "https://x/u/a" },
        to: [{ email: "a@example.com" }],
      },
      {
        substitutions: { "-unsub-": "https://x/u/b" },
        to: [{ email: "b@example.com" }],
      },
    ]);
  });

  test("SendGrid omits substitutions for a transactional send", async () => {
    await sendBulkEmails({ ...config, provider: "sendgrid" }, payload(1));
    const body = fetch.getFetchJsonBody();
    expect(body.personalizations).toEqual([
      { to: [{ email: "user0@example.com" }] },
    ]);
  });

  test("Mailgun posts one message with recipient-variables", async () => {
    const result = await sendBulkEmails(
      {
        ...config,
        fromAddress: validEmail("tickets@mg.example.com"),
        provider: "mailgun-us",
      },
      twoRecipientUnsubPayload(),
    );

    expect(result).toEqual({
      attempted: 2,
      batches: 1,
      failed: 0,
      responses: [okBatch],
    });
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
    expect(fetch.getFetchHeaders().Authorization).toBe(
      `Basic ${btoa("api:re_key")}`,
    );
    const form = fetch.getFetchFormBody();
    expect(form.getAll("to")).toEqual(["a@example.com", "b@example.com"]);
    expect(form.get("html")).toBe("<p>Hi</p>%recipient.unsub%");
    expect(JSON.parse(form.get("recipient-variables") as string)).toEqual({
      "a@example.com": { unsub: "https://x/u/a" },
      "b@example.com": { unsub: "https://x/u/b" },
    });
  });

  test("Mailgun (EU) uses the EU host and empty vars for transactional sends", async () => {
    await sendBulkEmails(
      {
        ...config,
        fromAddress: validEmail("t@mg.example.com"),
        provider: "mailgun-eu",
      },
      payload(1),
    );
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages");
    const form = fetch.getFetchFormBody();
    expect(JSON.parse(form.get("recipient-variables") as string)).toEqual({
      "user0@example.com": {},
    });
  });

  test("counts a failed batch's recipients and logs the error", async () => {
    fetch.restubFetch(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const errorSpy = spy(console, "error");
    try {
      const result = await sendBulkEmails(config, payload(3));
      expect(result).toEqual({
        attempted: 3,
        batches: 1,
        failed: 3,
        responses: [{ body: "nope", ok: false, status: 500 }],
      });
      const logged = errorSpy.calls.some((c) =>
        String(c.args[0]).includes("E_EMAIL_SEND"),
      );
      expect(logged).toBe(true);
    } finally {
      errorSpy.restore();
    }
  });

  test("sending no recipients makes no requests", async () => {
    const result = await sendBulkEmails(config, payload(0));
    expect(result).toEqual({
      attempted: 0,
      batches: 0,
      failed: 0,
      responses: [],
    });
    expect(fetch.callCount()).toBe(0);
  });
});
