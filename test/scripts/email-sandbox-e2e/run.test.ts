/** Direct tests for one email leg's probes, outcomes, and containment. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { runEmailLeg } from "#scripts/email-sandbox-e2e/run.ts";
import { BULK_UNSUBSCRIBE_PLACEHOLDER } from "#shared/email/bulk.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const resendEnv = {
  RESEND_API_KEY: "re_test_123",
  RESEND_FROM: undefined,
  RESEND_TO: undefined,
};

const mailgunEnv = {
  MAILGUN_EU_API_KEY: "key-abc",
  MAILGUN_EU_FROM: "e2e@sandbox123.mailgun.org",
  MAILGUN_EU_TO: "authorized@example.com",
};

const postmarkEnv = {
  POSTMARK_FROM: "sender@example.com",
  POSTMARK_SERVER_TOKEN: "POSTMARK_API_TEST",
  POSTMARK_TO: undefined,
};

const okJson = (): Response => new Response("{}", { status: 200 });

const callArgs = (
  fetched: ReturnType<typeof stubFetch>,
  index: number,
): [string, RequestInit] => fetched.calls[index]!.args as [string, RequestInit];

const jsonBody = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body));

describe("runEmailLeg on a ready resend leg", () => {
  test("sends the single probe production-shaped to the real endpoint", async () => {
    using _env = withEnv(resendEnv);
    using fetched = stubFetch(okJson(), okJson());
    await runEmailLeg("resend");
    const [url, init] = callArgs(fetched, 0);
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_123",
    );
    const body = jsonBody(init);
    expect(body.from).toBe("onboarding@resend.dev");
    expect(body.to).toEqual(["delivered@resend.dev"]);
    expect(body.reply_to).toBe("onboarding@resend.dev");
    expect(body.subject).toMatch(
      /^Email sandbox e2e [0-9a-f]{10} \(resend, single\)$/,
    );
    const attachments = body.attachments as {
      content: string;
      filename: string;
    }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe("probe.svg");
    expect(atob(attachments[0]!.content)).toContain("<svg");
  });

  test("sends the bulk probe with the unsubscribe substitution filled in", async () => {
    using _env = withEnv(resendEnv);
    using fetched = stubFetch(okJson(), okJson());
    await runEmailLeg("resend");
    const [url, init] = callArgs(fetched, 1);
    expect(url).toBe("https://api.resend.com/emails/batch");
    const batch = JSON.parse(String(init.body)) as {
      html: string;
      subject: string;
      to: string[];
    }[];
    expect(batch).toHaveLength(1);
    expect(batch[0]!.to).toEqual(["delivered@resend.dev"]);
    expect(batch[0]!.subject).toMatch(/\(resend, bulk\)$/);
    expect(batch[0]!.html).toContain('href="https://example.com/unsubscribe"');
    expect(batch[0]!.html).not.toContain(BULK_UNSUBSCRIBE_PLACEHOLDER);
  });

  test("reports both accepted sends as one sent leg", async () => {
    using _env = withEnv(resendEnv);
    using fetched = stubFetch(okJson(), okJson());
    expect(await runEmailLeg("resend")).toEqual({
      detail: "single 200, bulk 200",
      provider: "resend",
      state: "sent",
    });
    expect(fetched.calls).toHaveLength(2);
  });
});

describe("runEmailLeg on a ready mailgun leg", () => {
  test("derives the regional endpoint from the sender's domain", async () => {
    using _env = withEnv(mailgunEnv);
    using fetched = stubFetch(okJson(), okJson());
    expect((await runEmailLeg("mailgun-eu")).state).toBe("sent");
    const [singleUrl, init] = callArgs(fetched, 0);
    expect(singleUrl).toBe(
      "https://api.eu.mailgun.net/v3/sandbox123.mailgun.org/messages",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("api:key-abc")}`,
    );
    const form = init.body as FormData;
    expect(form.get("from")).toBe("e2e@sandbox123.mailgun.org");
    expect(form.get("to")).toBe("authorized@example.com");
    expect(form.get("h:Reply-To")).toBe("e2e@sandbox123.mailgun.org");
    const attachment = form.get("attachment") as File;
    expect(attachment.type).toBe("image/svg+xml");
  });

  test("keys the bulk recipient variables by the authorized recipient", async () => {
    using _env = withEnv(mailgunEnv);
    using fetched = stubFetch(okJson(), okJson());
    await runEmailLeg("mailgun-eu");
    const [, init] = callArgs(fetched, 1);
    const form = init.body as FormData;
    expect(JSON.parse(String(form.get("recipient-variables")))).toEqual({
      "authorized@example.com": { unsub: "https://example.com/unsubscribe" },
    });
  });
});

describe("runEmailLeg failure containment", () => {
  test("fails the leg and keeps both refusal bodies when the provider says no", async () => {
    using _env = withEnv(resendEnv);
    using _quiet = stub(console, "error");
    using _fetched = stubFetch(
      new Response("nope", { status: 500 }),
      new Response("bad | request\nline", { status: 422 }),
    );
    expect(await runEmailLeg("resend")).toEqual({
      detail: "single 500, bulk 422 — nope — bad request line",
      provider: "resend",
      state: "failed",
    });
  });

  test("truncates a long refusal body to one short line", async () => {
    using _env = withEnv(resendEnv);
    using _quiet = stub(console, "error");
    using _fetched = stubFetch(
      okJson(),
      new Response("x".repeat(300), { status: 400 }),
    );
    const outcome = await runEmailLeg("resend");
    expect(outcome.detail).toBe(`single 200, bulk 400 — ${"x".repeat(160)}`);
  });

  test("counts a non-2xx single status as failed even when bulk passes", async () => {
    using _env = withEnv(resendEnv);
    using _quiet = stub(console, "error");
    using _fetched = stubFetch(
      new Response("multiple choices", { status: 300 }),
      okJson(),
    );
    expect(await runEmailLeg("resend")).toEqual({
      detail: "single 300, bulk 200 — multiple choices",
      provider: "resend",
      state: "failed",
    });
  });

  test("blanks an echoed address before the report", async () => {
    using _env = withEnv(resendEnv);
    using _quiet = stub(console, "error");
    using _fetched = stubFetch(
      okJson(),
      new Response("recipient delivered@resend.dev is not allowed", {
        status: 422,
      }),
    );
    expect(await runEmailLeg("resend")).toEqual({
      detail: "single 200, bulk 422 — recipient [redacted] is not allowed",
      provider: "resend",
      state: "failed",
    });
  });

  test("leans on the status alone when a refusal body is empty", async () => {
    using _env = withEnv(resendEnv);
    using _quiet = stub(console, "error");
    using _fetched = stubFetch(new Response(null, { status: 500 }), okJson());
    expect(await runEmailLeg("resend")).toEqual({
      detail: "single 500, bulk 200",
      provider: "resend",
      state: "failed",
    });
  });

  test("reads a thrown single send as no response", async () => {
    using _env = withEnv(resendEnv);
    using _quiet = stub(console, "error");
    using _fetched = stubFetch(new Error("connection refused"), okJson());
    expect(await runEmailLeg("resend")).toEqual({
      detail: "single no response, bulk 200",
      provider: "resend",
      state: "failed",
    });
  });

  test("contains a bulk crash to a failed outcome for that leg", async () => {
    using _env = withEnv(resendEnv);
    using _fetched = stubFetch(okJson(), new Error("boom"));
    expect(await runEmailLeg("resend")).toEqual({
      detail: "boom",
      provider: "resend",
      state: "failed",
    });
  });

  test("turns a stalled provider into a failed leg instead of a hung run", async () => {
    using _env = withEnv(resendEnv);
    using time = new FakeTime();
    using _fetched = stubFetch(() => new Promise<Response>(() => {}));
    const pending = runEmailLeg("resend");
    await time.tickAsync(120_000);
    expect(await pending).toEqual({
      detail: "leg timed out after 120s",
      provider: "resend",
      state: "failed",
    });
  });

  test("cancels the stalled request when the leg times out", async () => {
    using _env = withEnv(resendEnv);
    using time = new FakeTime();
    const aborted = { signals: [] as AbortSignal[] };
    using _fetched = stubFetch((_url, init) => {
      if (init?.signal) aborted.signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    const pending = runEmailLeg("resend");
    await time.tickAsync(120_000);
    await pending;

    expect(aborted.signals).toHaveLength(1);
    expect(aborted.signals[0]?.aborted).toBe(true);
  });
});

const UNCONFIRMED = "1 message(s) left unconfirmed";

describe("runEmailLeg on a ready postmark leg", () => {
  const acceptedBatch = '[{"ErrorCode":0,"Message":"OK"}]';

  test("counts an accepted batch with clean per-message results as sent", async () => {
    using _env = withEnv(postmarkEnv);
    using _fetched = stubFetch(okJson(), new Response(acceptedBatch));
    expect(await runEmailLeg("postmark")).toEqual({
      detail: "single 200, bulk 200",
      provider: "postmark",
      state: "sent",
    });
  });

  test("fails on a nonzero per-message ErrorCode behind an accepted batch", async () => {
    using _env = withEnv(postmarkEnv);
    using _fetched = stubFetch(
      okJson(),
      new Response('[{"ErrorCode":406,"Message":"Inactive recipient"}]'),
    );
    expect(await runEmailLeg("postmark")).toEqual({
      detail: "single 200, bulk 200 — Postmark error 406: Inactive recipient",
      provider: "postmark",
      state: "failed",
    });
  });

  /** The provider took the batch but said nothing about the probe, so the
   * leg cannot claim it sent. */
  const expectUnconfirmed = async () => {
    expect(await runEmailLeg("postmark")).toEqual({
      detail: `single 200, bulk 200 — ${UNCONFIRMED}`,
      provider: "postmark",
      state: "failed",
    });
  };

  test("fails when an accepted batch reply has no per-message results", async () => {
    using _env = withEnv(postmarkEnv);
    using _fetched = stubFetch(okJson(), new Response("{}"));
    await expectUnconfirmed();
  });

  test("fails when an accepted batch reply is an empty list", async () => {
    using _env = withEnv(postmarkEnv);
    using _fetched = stubFetch(okJson(), new Response("[]"));
    await expectUnconfirmed();
  });

  test("fails when an accepted batch reply is not JSON", async () => {
    using _env = withEnv(postmarkEnv);
    using _fetched = stubFetch(okJson(), new Response("not json"));
    await expectUnconfirmed();
  });

  test("keeps an address out of the report when the reply is unreadable", async () => {
    using _env = withEnv(postmarkEnv);
    using _fetched = stubFetch(okJson(), new Response("to@example.com"));
    const outcome = await runEmailLeg("postmark");
    expect(outcome.state).toBe("failed");
    expect(outcome.detail).not.toContain("to@example.com");
  });

  test("skips the per-message read when the batch itself was refused", async () => {
    using _env = withEnv(postmarkEnv);
    using _quiet = stub(console, "error");
    using _fetched = stubFetch(
      okJson(),
      new Response("Unauthorized", { status: 401 }),
    );
    expect(await runEmailLeg("postmark")).toEqual({
      detail: "single 200, bulk 401 — Unauthorized",
      provider: "postmark",
      state: "failed",
    });
  });
});

describe("runEmailLeg without a runnable plan", () => {
  test("passes a skip through without touching the network", async () => {
    using _env = withEnv({ RESEND_API_KEY: undefined });
    using fetched = stubFetch(new Error("no call expected"));
    expect(await runEmailLeg("resend")).toEqual({
      detail: "RESEND_API_KEY is not set",
      provider: "resend",
      state: "skipped",
    });
    expect(fetched.calls).toHaveLength(0);
  });

  test("fails a switched-on leg with a bad companion before any request", async () => {
    using _env = withEnv({ SENDGRID_API_KEY: "SG.key", SENDGRID_FROM: "" });
    using fetched = stubFetch(new Error("no call expected"));
    expect(await runEmailLeg("sendgrid")).toEqual({
      detail: "SENDGRID_FROM is not set",
      provider: "sendgrid",
      state: "failed",
    });
    expect(fetched.calls).toHaveLength(0);
  });
});
