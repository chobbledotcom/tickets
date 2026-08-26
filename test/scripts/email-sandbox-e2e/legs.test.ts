/** Direct tests for the email leg table and its env resolution. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseEmailTarget,
  resolveEmailLeg,
} from "#scripts/email-sandbox-e2e/legs.ts";
import { VALID_EMAIL_PROVIDERS } from "#shared/email.ts";
import { withEnv } from "#test-utils/env.ts";

describe("resolveEmailLeg", () => {
  test("skips a leg whose on-switch secret is unset", () => {
    using _env = withEnv({ RESEND_API_KEY: undefined });
    expect(resolveEmailLeg("resend")).toEqual({
      reason: "RESEND_API_KEY is not set",
      state: "skipped",
    });
  });

  test("treats a blank on-switch secret as unset, like a missing Actions secret", () => {
    using _env = withEnv({ MAILGUN_EU_API_KEY: "  " });
    expect(resolveEmailLeg("mailgun-eu")).toEqual({
      reason: "MAILGUN_EU_API_KEY is not set",
      state: "skipped",
    });
  });

  test("readies resend on the key alone, with the documented safe addresses", () => {
    using _env = withEnv({
      RESEND_API_KEY: " re_test_123 ",
      RESEND_FROM: undefined,
      RESEND_TO: undefined,
    });
    expect(resolveEmailLeg("resend")).toEqual({
      config: {
        apiKey: "re_test_123",
        fromAddress: "onboarding@resend.dev",
        provider: "resend",
      },
      state: "ready",
      to: "delivered@resend.dev",
    });
  });

  test("lets a secret override each default address", () => {
    using _env = withEnv({
      RESEND_API_KEY: "re_test_123",
      RESEND_FROM: "sender@verified.example.com",
      RESEND_TO: "delivered+run@resend.dev",
    });
    expect(resolveEmailLeg("resend")).toEqual({
      config: {
        apiKey: "re_test_123",
        fromAddress: "sender@verified.example.com",
        provider: "resend",
      },
      state: "ready",
      to: "delivered+run@resend.dev",
    });
  });

  test("readies postmark with the blackhole discard address by default", () => {
    using _env = withEnv({
      POSTMARK_FROM: "sender@example.com",
      POSTMARK_SERVER_TOKEN: "POSTMARK_API_TEST",
      POSTMARK_TO: undefined,
    });
    expect(resolveEmailLeg("postmark")).toEqual({
      config: {
        apiKey: "POSTMARK_API_TEST",
        fromAddress: "sender@example.com",
        provider: "postmark",
      },
      state: "ready",
      to: "test@blackhole.postmarkapp.com",
    });
  });

  test("readies sendgrid with the sink recipient by default", () => {
    using _env = withEnv({
      SENDGRID_API_KEY: "SG.key",
      SENDGRID_FROM: "verified@example.com",
      SENDGRID_TO: undefined,
    });
    expect(resolveEmailLeg("sendgrid")).toEqual({
      config: {
        apiKey: "SG.key",
        fromAddress: "verified@example.com",
        provider: "sendgrid",
      },
      state: "ready",
      to: "e2e@sink.sendgrid.net",
    });
  });

  test("breaks a switched-on leg whose required sender is unset", () => {
    using _env = withEnv({
      SENDGRID_API_KEY: "SG.key",
      SENDGRID_FROM: "",
    });
    expect(resolveEmailLeg("sendgrid")).toEqual({
      reason: "SENDGRID_FROM is not set",
      state: "broken",
    });
  });

  test("breaks a switched-on leg whose sender is not an email address", () => {
    using _env = withEnv({
      POSTMARK_FROM: "not-an-address",
      POSTMARK_SERVER_TOKEN: "token",
    });
    expect(resolveEmailLeg("postmark")).toEqual({
      reason: "POSTMARK_FROM is not a valid email address",
      state: "broken",
    });
  });

  test("breaks a switched-on mailgun leg whose recipient is unset", () => {
    using _env = withEnv({
      MAILGUN_EU_API_KEY: "key-abc",
      MAILGUN_EU_FROM: "e2e@sandbox123.mailgun.org",
      MAILGUN_EU_TO: undefined,
    });
    expect(resolveEmailLeg("mailgun-eu")).toEqual({
      reason: "MAILGUN_EU_TO is not set",
      state: "broken",
    });
  });

  test("names the US region's secrets on the mailgun-us leg", () => {
    using _env = withEnv({
      MAILGUN_US_API_KEY: "key-us",
      MAILGUN_US_FROM: "e2e@mg.example.com",
      MAILGUN_US_TO: "authorized@example.com",
    });
    expect(resolveEmailLeg("mailgun-us")).toEqual({
      config: {
        apiKey: "key-us",
        fromAddress: "e2e@mg.example.com",
        provider: "mailgun-us",
      },
      state: "ready",
      to: "authorized@example.com",
    });
  });
});

describe("parseEmailTarget", () => {
  test("selects every provider by default, in the production order", () => {
    expect(parseEmailTarget(undefined)).toEqual([...VALID_EMAIL_PROVIDERS]);
    expect(parseEmailTarget("all")).toEqual([...VALID_EMAIL_PROVIDERS]);
  });

  test("selects one named provider, case-insensitively", () => {
    expect(parseEmailTarget("RESEND")).toEqual(["resend"]);
    expect(parseEmailTarget("mailgun-eu")).toEqual(["mailgun-eu"]);
  });

  test("refuses an unknown target and names the expected ones", () => {
    expect(() => parseEmailTarget("stripe")).toThrow(
      'unknown target "stripe" (expected all|mailgun-eu|mailgun-us|postmark|resend|sendgrid)',
    );
  });
});
