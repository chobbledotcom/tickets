import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { sendSuperuserCredentialsEmail } from "#shared/superuser.ts";
import { validEmail } from "#test-utils/email.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { says } from "#test-utils/says.ts";

describe("sendSuperuserCredentialsEmail", () => {
  const EMAIL_CONFIG = {
    apiKey: "test",
    fromAddress: validEmail("from@test.com"),
    provider: "resend" as const,
  };

  const RECIPIENT = {
    email: validEmail("admin@example.com"),
    password: "a1b2c3d4e5f6",
    username: "myadmin",
  };

  /** Send the credentials email, returning its captured Resend body + result. */
  const sendAndCapture = async (
    overrides: Partial<typeof RECIPIENT> = {},
  ): Promise<{
    result: boolean;
    callCount: number;
    body: Record<string, unknown>;
  }> => {
    using fetchStub = stubFetch(new Response());
    const result = await sendSuperuserCredentialsEmail(EMAIL_CONFIG, {
      ...RECIPIENT,
      ...overrides,
    });
    const [, init] = fetchStub.calls[0]!.args as [string, RequestInit];
    return {
      body: JSON.parse(init.body as string),
      callCount: fetchStub.calls.length,
      result,
    };
  };

  const expectEmailBodyContains =
    (field: "html" | "text") =>
    (...values: string[]) =>
    async (): Promise<void> => {
      const { body } = await sendAndCapture();
      const content = String(body[field]);
      for (const value of values) says(content, value);
    };

  test("calls sendEmail with the provided config and a correctly structured message", async () => {
    const { result, callCount, body } = await sendAndCapture();
    expect(result).toBe(true);
    expect(callCount).toBe(1);
    expect(body.to).toEqual(["admin@example.com"]);
    expect(body.subject).toBe("Superuser account enabled");
  });

  test("email text body contains the username", async () => {
    await expectEmailBodyContains("text")("myadmin")();
  });

  test("email text body contains the temporary password", async () => {
    await expectEmailBodyContains("text")("a1b2c3d4e5f6")();
  });

  test("email text body contains the site login URL via getEffectiveDomain", async () => {
    setEffectiveDomainForTest("example.com");
    try {
      await expectEmailBodyContains("text")("https://example.com/admin/")();
    } finally {
      resetEffectiveDomain();
    }
  });

  test("resetting the effective domain restores localhost email links", async () => {
    setEffectiveDomainForTest("example.com");
    resetEffectiveDomain();

    await expectEmailBodyContains("text")("https://localhost/admin/")();
  });

  test("email text body opens by saying what happened", async () => {
    await expectEmailBodyContains("text")(
      "A superuser account has been enabled for this ticket platform.",
    )();
  });

  test("email html body escapes an apostrophe in the username", async () => {
    const { body } = await sendAndCapture({ username: "o'brien" });
    const html = String(body.html);
    says(html, "o&#39;brien");
    assert(!html.includes("o'brien"));
  });

  test("email text body contains a security warning", async () => {
    await expectEmailBodyContains("text")(
      "Store this password securely",
      "decrypt attendee data",
    )();
  });

  test("email HTML body contains the same information with HTML-escaped values", async () => {
    await expectEmailBodyContains("html")("myadmin", "a1b2c3d4e5f6")();
  });

  test("HTML body escapes special characters in password", async () => {
    const { body } = await sendAndCapture({ password: "abc<foo>&bar" });
    says(String(body.html), "&lt;");
    says(String(body.html), "&amp;");
    assert(!String(body.html).includes("abc<foo>"));
  });

  const STATUS_RESULTS: { status: number; expected: boolean }[] = [
    { expected: true, status: 200 },
    { expected: true, status: 201 },
    { expected: true, status: 299 },
    { expected: false, status: 300 },
    { expected: false, status: 400 },
    { expected: false, status: 500 },
  ];

  for (const { status, expected } of STATUS_RESULTS) {
    test(`returns ${expected} for status ${status}`, async () => {
      using _fetch = stubFetch(new Response(null, { status }));
      const result = await sendSuperuserCredentialsEmail(
        EMAIL_CONFIG,
        RECIPIENT,
      );
      expect(result).toBe(expected);
    });
  }

  test("does not log the password", async () => {
    const logSpy = spy(console, "log");
    const errSpy = spy(console, "error");
    try {
      using _fetch = stubFetch(new Response());
      await sendSuperuserCredentialsEmail(EMAIL_CONFIG, RECIPIENT);
      const allArgs = [...logSpy.calls, ...errSpy.calls].flatMap((c) => c.args);
      expect(allArgs.some((a) => String(a).includes("a1b2c3d4e5f6"))).toBe(
        false,
      );
    } finally {
      logSpy.restore();
      errSpy.restore();
    }
  });
});
