import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  BULK_EMAIL_PROVIDERS,
  type BulkEmailMessage,
  type EmailConfig,
  isBulkEmailProvider,
  sendBulkEmails,
} from "#shared/email.ts";
import { useFetchStub } from "#test-utils";

const config: EmailConfig = {
  apiKey: "re_key",
  fromAddress: "tickets@example.com",
  provider: "resend",
};

const messages = (n: number): BulkEmailMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    html: `<p>${i}</p>`,
    text: `${i}`,
    to: `user${i}@example.com`,
  }));

describe("isBulkEmailProvider", () => {
  test("accepts batch-capable providers", () => {
    expect(isBulkEmailProvider("resend")).toBe(true);
    expect(isBulkEmailProvider("postmark")).toBe(true);
  });

  test("rejects providers without a batch API", () => {
    expect(isBulkEmailProvider("sendgrid")).toBe(false);
    expect(isBulkEmailProvider("mailgun-us")).toBe(false);
    expect(isBulkEmailProvider("nope")).toBe(false);
  });

  test("BULK_EMAIL_PROVIDERS lists exactly the batch providers", () => {
    expect([...BULK_EMAIL_PROVIDERS].sort()).toEqual(["postmark", "resend"]);
  });
});

describe("sendBulkEmails", () => {
  const fetch = useFetchStub();

  test("Resend posts one batch request with all messages", async () => {
    const result = await sendBulkEmails(config, "resend", "Hello", messages(3));

    expect(result).toEqual({ attempted: 3, batches: 1, failed: 0 });
    expect(fetch.callCount()).toBe(1);
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.resend.com/emails/batch");
    expect(fetch.getFetchHeaders().Authorization).toBe("Bearer re_key");
    const body = fetch.getFetchJsonBody();
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual({
      from: "tickets@example.com",
      html: "<p>0</p>",
      subject: "Hello",
      text: "0",
      to: ["user0@example.com"],
    });
  });

  test("Resend chunks messages beyond the 100-per-batch limit", async () => {
    const result = await sendBulkEmails(config, "resend", "Hi", messages(101));

    expect(result).toEqual({ attempted: 101, batches: 2, failed: 0 });
    expect(fetch.callCount()).toBe(2);
    expect(fetch.getFetchJsonBody(0)).toHaveLength(100);
    expect(fetch.getFetchJsonBody(1)).toHaveLength(1);
  });

  test("Postmark posts to the batch endpoint with Postmark field names", async () => {
    const result = await sendBulkEmails(
      { ...config, provider: "postmark" },
      "postmark",
      "Subject",
      messages(2),
    );

    expect(result).toEqual({ attempted: 2, batches: 1, failed: 0 });
    const [url] = fetch.getFetchArgs();
    expect(url).toBe("https://api.postmarkapp.com/email/batch");
    expect(fetch.getFetchHeaders()["X-Postmark-Server-Token"]).toBe("re_key");
    const body = fetch.getFetchJsonBody();
    expect(body[0]).toEqual({
      From: "tickets@example.com",
      HtmlBody: "<p>0</p>",
      Subject: "Subject",
      TextBody: "0",
      To: "user0@example.com",
    });
  });

  test("counts a failed batch's recipients and logs the error", async () => {
    fetch.restubFetch(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const errorSpy = spy(console, "error");
    try {
      const result = await sendBulkEmails(config, "resend", "Hi", messages(3));
      expect(result).toEqual({ attempted: 3, batches: 1, failed: 3 });
      const logged = errorSpy.calls.some((c) =>
        String(c.args[0]).includes("E_EMAIL_SEND"),
      );
      expect(logged).toBe(true);
    } finally {
      errorSpy.restore();
    }
  });

  test("sending no messages makes no requests", async () => {
    const result = await sendBulkEmails(config, "resend", "Hi", []);
    expect(result).toEqual({ attempted: 0, batches: 0, failed: 0 });
    expect(fetch.callCount()).toBe(0);
  });
});
