import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  deliverRegistrationEmail,
  type EmailConfig,
  type EmailMessage,
  sendEmail,
} from "#shared/email.ts";
import {
  minimalEmailMessage,
  testEmailConfig,
  validEmail,
} from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

type ExpectedFailure = {
  logged: string;
  reason?: string;
  status: number | undefined;
};

/** Run one call with `console.error` captured, so a test can read the lines. */
const withErrorLog = async <T>(
  run: () => Promise<T>,
): Promise<{ logs: string[]; result: T }> => {
  const errorSpy = spy(console, "error");
  try {
    const result = await run();
    return { logs: errorSpy.calls.map((call) => String(call.args[0])), result };
  } finally {
    errorSpy.restore();
  }
};

const expectSendEmailError = async (
  config: EmailConfig,
  msg: EmailMessage,
  expected: ExpectedFailure,
): Promise<void> => {
  const { logs, result: delivery } = await withErrorLog(() =>
    sendEmail(config, msg),
  );
  expect(delivery.delivered).toBe(false);
  if (delivery.delivered) return;
  expect(delivery.status).toBe(expected.status);
  if (expected.reason !== undefined) {
    expect(delivery.reason).toBe(expected.reason);
  }
  assert(!logs.join("\n").includes(msg.to));
  const line = logs.find((entry) => entry.includes("E_EMAIL_SEND"));
  expect(line).toBe(`[Error] E_EMAIL_SEND ${expected.logged}`);
  if (expected.reason) assert(!(line ?? "").includes(expected.reason));
};

/** One provider reply, the status it carries, and the reason the send keeps. */
type ReplyCase = readonly [
  reply: string | null,
  status: number,
  reason: string,
  provider?: EmailConfig["provider"],
];

describe("sendEmail", () => {
  const fetch = useFetchStub();

  const restubReply = (body: string | null, status: number): void =>
    fetch.restubFetch(() => Promise.resolve(new Response(body, { status })));

  const REPLY_CASES: readonly ReplyCase[] = [
    ["provider-reply-marker", 500, "provider-reply-marker"],
    ['{"error":"Invalid API key"}', 401, "Invalid API key"],
    [
      '{"ErrorCode":10,"Message":"Bad API token"}',
      401,
      "Bad API token",
      "postmark",
    ],
    [
      '{"message":"You can only send testing emails to your own email address (owner@gmail.com)"}',
      403,
      "You can only send testing emails to your own email address [redacted]",
    ],
    ["Access\n\n  denied", 403, "Access denied"],
    ["x".repeat(1000), 500, `${"x".repeat(300)}...`],
    ["y".repeat(300), 500, "y".repeat(300)],
    [null, 500, ""],
  ];

  const SENDGRID_REPLIES: readonly (readonly [string, string])[] = [
    [
      '{"errors":[{"message":"The from address tickets@example.com is not a verified Sender Identity"}]}',
      "The from address [redacted] is not a verified Sender Identity",
    ],
    [
      '{"errors":[{"field":"from","help":null,"message":"The from address does not match a verified Sender Identity"}]}',
      "The from address does not match a verified Sender Identity",
    ],
  ];

  for (const [reply, status, reason, provider] of REPLY_CASES) {
    test(`reads the ${provider ?? "resend"} reply "${reason.slice(0, 24)}"`, async () => {
      restubReply(reply, status);
      const config =
        provider === undefined
          ? testEmailConfig
          : { ...testEmailConfig, provider };
      await expectSendEmailError(config, minimalEmailMessage, {
        logged: `detail="provider=${config.provider} status=${status}"`,
        reason,
        status,
      });
    });
  }

  for (const [reply, reason] of SENDGRID_REPLIES) {
    test(`reads SendGrid's reason "${reason.slice(0, 24)}"`, async () => {
      restubReply(reply, 403);
      await expectSendEmailError(
        { ...testEmailConfig, provider: "sendgrid" },
        minimalEmailMessage,
        {
          logged: 'detail="provider=sendgrid status=403"',
          reason,
          status: 403,
        },
      );
    });
  }

  test("marks a reason that the activity log carries", async () => {
    restubReply("provider-reply-marker", 500);

    const { logs } = await withErrorLog(() =>
      withRequestContext(() => sendEmail(testEmailConfig, minimalEmailMessage)),
    );

    const line = logs.find((entry) => entry.includes("E_EMAIL_SEND"));
    expect(line).toContain('operatorDetail="(activity log)"');
  });

  test("scrubs the send's own addresses from the reason", async () => {
    restubReply(
      '{"message":"a@b.com reply@test.com and tickets@example.com are not allowed"}',
      400,
    );

    await expectSendEmailError(
      testEmailConfig,
      { ...minimalEmailMessage, replyTo: validEmail("reply@test.com") },
      {
        logged: 'detail="provider=resend status=400"',
        reason: "[redacted] [redacted] and [redacted] are not allowed",
        status: 400,
      },
    );
  });

  test("returns no status on fetch failure", async () => {
    fetch.restubFetch(() => Promise.reject(new Error("Network error")));

    await expectSendEmailError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="Network error"',
      reason: "",
      status: undefined,
    });
  });

  test("returns no status for non-Error thrown values", async () => {
    fetch.restubFetch(() => Promise.reject("string error"));

    await expectSendEmailError(testEmailConfig, minimalEmailMessage, {
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
