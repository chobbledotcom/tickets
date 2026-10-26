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

type ExpectedFailure = {
  logged: string;
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
    assert(!logs.join("\n").includes(msg.to));
    const line = logs.find((l) => l.includes("E_EMAIL_SEND"));
    expect(line).toBe(`[Error] E_EMAIL_SEND ${expected.logged}`);
    if (expected.reason) assert(!(line ?? "").includes(expected.reason));
  } finally {
    errorSpy.restore();
  }
};

describe("sendEmail", () => {
  const fetch = useFetchStub();

  const restubReply = (body: string | null, status: number): void =>
    fetch.restubFetch(() => Promise.resolve(new Response(body, { status })));

  test("keeps the provider reply body out of the console", async () => {
    restubReply("provider-reply-marker", 500);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=500"',
      reason: "provider-reply-marker",
      status: 500,
    });
  });

  test("reads SendGrid's message from its errors array", async () => {
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
        logged: 'detail="provider=sendgrid status=403"',
        reason: message,
        status: 403,
      },
    );
  });

  test("reads a plain error key in a reply", async () => {
    restubReply('{"error":"Invalid API key"}', 401);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=401"',
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
        logged: 'detail="provider=postmark status=401"',
        reason: "Bad API token",
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
        logged: 'detail="provider=resend status=400"',
        reason: "[redacted] [redacted] and [redacted] are not allowed",
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
      logged: 'detail="provider=resend status=403"',
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
        logged: 'detail="provider=sendgrid status=403"',
        reason: "The from address [redacted] is not a verified Sender Identity",
        status: 403,
      },
    );
  });

  test("puts a multi-line reply onto one reason line", async () => {
    restubReply("Access\n\n  denied", 403);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=403"',
      reason: "Access denied",
      status: 403,
    });
  });

  test("caps an over-long reply", async () => {
    restubReply("x".repeat(1000), 500);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=500"',
      reason: `${"x".repeat(300)}...`,
      status: 500,
    });
  });

  test("keeps a reply exactly at the cap whole", async () => {
    restubReply("y".repeat(300), 500);

    await sendEmailExpectingError(testEmailConfig, minimalEmailMessage, {
      logged: 'detail="provider=resend status=500"',
      reason: "y".repeat(300),
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
