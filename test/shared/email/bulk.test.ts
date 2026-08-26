import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  BULK_UNSUBSCRIBE_PLACEHOLDER,
  type BulkEmailPayload,
  type BulkSendResult,
  sendBulkEmails,
} from "#shared/email/bulk.ts";
import type { EmailConfig } from "#shared/email.ts";
import { validEmail } from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";

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

/** Nothing inside the batch was refused or left unreported. */
const tookAll = { reasons: [], refused: 0, unconfirmed: 0 };

/** The stub fetch returns an empty 200, so each batch records this response. */
const okBatch = { body: "", ok: true, outcome: tookAll, status: 200 };

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
  text: `Hi ${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
});

describe("sendBulkEmails", () => {
  const fetch = useFetchStub();

  const expectPostedBatch = (result: BulkSendResult, expectedUrl: string) => {
    expect(result).toEqual({
      attempted: 2,
      batches: 1,
      failed: 0,
      responses: [okBatch],
      taken: result.taken,
      unconfirmed: 0,
    });
    expect(result.taken).toHaveLength(2);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe(expectedUrl);
  };

  const postmark: EmailConfig = { ...config, provider: "postmark" };

  /** Postmark's batch reply: one result per message, 0 when it was taken. */
  const postmarkReply = (...codes: number[]) =>
    JSON.stringify(
      codes.map((ErrorCode) => ({
        ErrorCode,
        Message: ErrorCode === 0 ? "OK" : "Inactive recipient",
      })),
    );

  const replyWith = (body: string, status = 200) =>
    fetch.restubFetch(() => Promise.resolve(new Response(body, { status })));

  test("Resend posts one batch request with all recipients", async () => {
    const result = await sendBulkEmails(config, payload(3));

    expect(result).toEqual({
      attempted: 3,
      batches: 1,
      failed: 0,
      responses: [okBatch],
      taken: [
        validEmail("user0@example.com"),
        validEmail("user1@example.com"),
        validEmail("user2@example.com"),
      ],
      unconfirmed: 0,
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
      taken: result.taken,
      unconfirmed: 0,
    });
    expect(result.taken).toHaveLength(101);
    expect(fetch.callCount()).toBe(2);
    expect(fetch.getFetchJsonBody(0)).toHaveLength(100);
    expect(fetch.getFetchJsonBody(1)).toHaveLength(1);
  });

  test("Postmark posts to the batch endpoint with Postmark field names", async () => {
    replyWith(postmarkReply(0, 0));
    const result = await sendBulkEmails(postmark, payload(2));

    expect(result.failed).toBe(0);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.postmarkapp.com/email/batch");
    expect(fetch.getFetchHeaders()["X-Postmark-Server-Token"]).toBe("re_key");
    expect(fetch.getFetchHeaders().Accept).toBe("application/json");
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
    expect(body.content).toContainEqual({
      type: "text/plain",
      value: "Hi -unsub-",
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

  /** A batch can mix recipients who carry an unsubscribe link with ones who
   * do not. The ones who do not get the placeholder blanked, never left in
   * the message for a reader to see. */
  const oneRecipientNoUnsubPayload = (): BulkEmailPayload => ({
    html: `<p>Hi</p>${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
    recipients: [{ to: validEmail("a@example.com") }],
    subject: "Promo",
    text: `Hi ${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
  });

  test("Postmark blanks the placeholder for a recipient with no link", async () => {
    replyWith(postmarkReply(0));

    await sendBulkEmails(postmark, oneRecipientNoUnsubPayload());

    const body = fetch.getFetchJsonBody();
    expect(body[0].HtmlBody).toBe("<p>Hi</p>");
    expect(body[0].TextBody).toBe("Hi ");
  });

  test("Resend blanks the placeholder for a recipient with no link", async () => {
    await sendBulkEmails(config, oneRecipientNoUnsubPayload());

    const body = fetch.getFetchJsonBody();
    expect(body[0].html).toBe("<p>Hi</p>");
    expect(body[0].text).toBe("Hi ");
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

    expectPostedBatch(
      result,
      "https://api.mailgun.net/v3/mg.example.com/messages",
    );
    expect(fetch.getFetchHeaders().Authorization).toBe(
      `Basic ${btoa("api:re_key")}`,
    );
    const form = fetch.getFetchFormBody();
    expect(form.getAll("to")).toEqual(["a@example.com", "b@example.com"]);
    expect(form.get("subject")).toBe("Promo");
    expect(form.get("html")).toBe("<p>Hi</p>%recipient.unsub%");
    expect(form.get("text")).toBe("Hi %recipient.unsub%");
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
        responses: [
          {
            body: "nope",
            ok: false,
            outcome: { reasons: [], refused: 3, unconfirmed: 0 },
            status: 500,
          },
        ],
        taken: [],
        unconfirmed: 0,
      });
      const logged = errorSpy.calls.some((c) =>
        String(c.args[0]).includes("E_EMAIL_SEND"),
      );
      expect(logged).toBe(true);
    } finally {
      errorSpy.restore();
    }
  });

  test("counts a message Postmark refused inside an accepted batch", async () => {
    replyWith(postmarkReply(0, 406, 0));
    const result = await sendBulkEmails(postmark, payload(3));

    expect(result.failed).toBe(1);
    expect(result.responses[0]?.outcome).toEqual({
      reasons: ["Postmark error 406: Inactive recipient"],
      refused: 1,
      unconfirmed: 0,
    });
    // The refused message's recipient is not recorded as contacted.
    expect(result.taken).toEqual([
      validEmail("user0@example.com"),
      validEmail("user2@example.com"),
    ]);
  });

  test("counts no refusal when Postmark took every message", async () => {
    replyWith(postmarkReply(0, 0));
    const result = await sendBulkEmails(postmark, payload(2));

    expect(result.failed).toBe(0);
    expect(result.responses[0]?.outcome).toEqual(tookAll);
  });

  test("logs the refused count when an accepted batch refuses a message", async () => {
    replyWith(postmarkReply(406));
    const errorSpy = spy(console, "error");
    try {
      await sendBulkEmails(postmark, payload(1));
      const logged = errorSpy.calls.map((c) => String(c.args[0])).join("\n");
      expect(logged).toContain("E_EMAIL_SEND");
      expect(logged).toContain("count=1");
    } finally {
      errorSpy.restore();
    }
  });

  test("blanks an address a Postmark refusal quotes", async () => {
    replyWith(
      JSON.stringify([
        { ErrorCode: 406, Message: "Recipient user0@example.com is inactive" },
      ]),
    );
    const result = await sendBulkEmails(postmark, payload(1));

    const [reason] = result.responses[0]?.outcome.reasons ?? [];
    expect(reason).toBe("Postmark error 406: Recipient [redacted] is inactive");
  });

  test("leaves the batch unconfirmed when Postmark's reply cannot be read", async () => {
    replyWith("not json at all");
    const result = await sendBulkEmails(postmark, payload(2));

    // Postmark took the batch, so these are not refusals. Calling them
    // refused would invite a second send to people who already have it.
    expect(result.unconfirmed).toBe(2);
    expect(result.failed).toBe(0);
  });

  test("leaves the batch unconfirmed when a Postmark reply is the wrong shape", async () => {
    replyWith('{"Message":"queued"}');
    const result = await sendBulkEmails(postmark, payload(2));

    expect(result.unconfirmed).toBe(2);
    expect(result.failed).toBe(0);
  });

  test("leaves the batch unconfirmed when Postmark skips a message", async () => {
    replyWith(postmarkReply(0));
    const result = await sendBulkEmails(postmark, payload(2));

    expect(result.unconfirmed).toBe(2);
    expect(result.failed).toBe(0);
  });

  test("keeps an unconfirmed recipient out of the taken list", async () => {
    replyWith("not json at all");
    const result = await sendBulkEmails(postmark, payload(2));

    // Taken is what the contact history records and what the operator is
    // told went. A message the reply never accounted for is neither.
    expect(result.taken).toEqual([]);
  });

  test("takes only the messages a mixed Postmark reply confirmed", async () => {
    replyWith(postmarkReply(0, 406, 0));
    const result = await sendBulkEmails(postmark, payload(3));

    expect(result.taken).toEqual([
      validEmail("user0@example.com"),
      validEmail("user2@example.com"),
    ]);
    expect(result.unconfirmed).toBe(0);
  });

  test("does not log an error for a batch it merely could not confirm", async () => {
    replyWith("not json at all");
    const errorSpy = spy(console, "error");
    try {
      await sendBulkEmails(postmark, payload(2));
      expect(errorSpy.calls).toHaveLength(0);
    } finally {
      errorSpy.restore();
    }
  });

  test("a provider that answers 200 with prose still counts as sent", async () => {
    replyWith("queued");
    const result = await sendBulkEmails(config, payload(2));

    expect(result.failed).toBe(0);
    expect(result.responses[0]?.outcome).toEqual(tookAll);
  });

  test("aborting the signal stops the batch request in flight", async () => {
    const controller = new AbortController();
    fetch.restubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // Fail fast rather than hang when no signal reaches the request.
          if (!init?.signal)
            return reject(new Error("no signal reached fetch"));
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const sending = sendBulkEmails(config, payload(1), controller.signal);
    controller.abort();

    await expect(sending).rejects.toThrow("Aborted");
  });

  test("sending no recipients makes no requests", async () => {
    const result = await sendBulkEmails(config, payload(0));
    expect(result).toEqual({
      attempted: 0,
      batches: 0,
      failed: 0,
      responses: [],
      taken: [],
      unconfirmed: 0,
    });
    expect(fetch.callCount()).toBe(0);
  });
});
