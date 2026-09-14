/** Direct tests for the harness's crash report to the bug catcher. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { config } from "#e2e/config.ts";
import { reportCrash } from "#e2e/sentry.ts";
import { sentrySdk } from "#shared/sentry-sdk.ts";

const DSN = "https://key@bugs.example.test/2";

/** reportCrash never reads the client a real init returns, so a void is safe. */
const noopInit = (() => undefined) as unknown as typeof sentrySdk.init;

/** Point config.sentryUrl at a value for one test scope, then restore it. */
const withSentryUrl = (value: string | undefined): Disposable => {
  const before = config.sentryUrl;
  config.sentryUrl = value;
  return {
    [Symbol.dispose]: () => {
      config.sentryUrl = before;
    },
  };
};

type SdkAnswers = {
  alreadyUp?: boolean;
  refused?: boolean;
};

/** The four SDK seams reportCrash touches, stubbed for one call scope. */
const withStubbedSdk = (answers: SdkAnswers = {}) => {
  const stubs = {
    capture: stub(
      sentrySdk,
      "captureReport",
      answers.refused
        ? () => {
            throw new Error("transport refused");
          }
        : () => "stub-event-id",
    ),
    flush: stub(sentrySdk, "flush", () => Promise.resolve(true)),
    init: stub(sentrySdk, "init", noopInit),
    initialized: stub(
      sentrySdk,
      "isInitialized",
      () => answers.alreadyUp === true,
    ),
  };
  return {
    ...stubs,
    [Symbol.dispose]: () => {
      for (const one of Object.values(stubs)) one.restore();
    },
  };
};

describe("reportCrash", () => {
  it("sends nothing without a configured DSN", async () => {
    using _url = withSentryUrl(undefined);
    using sdk = withStubbedSdk();

    await reportCrash("email sandbox e2e", "all", new Error("boom"));

    expect(sdk.init.calls).toHaveLength(0);
    expect(sdk.capture.calls).toHaveLength(0);
    expect(sdk.flush.calls).toHaveLength(0);
  });

  it("initializes the SDK and captures the exception itself", async () => {
    using _url = withSentryUrl(DSN);
    using sdk = withStubbedSdk();

    const crash = new Error("the tunnel never came up");
    await reportCrash("payment sandbox e2e", "stripe", crash);

    expect(sdk.init.calls).toHaveLength(1);
    expect(sdk.init.calls[0]?.args[0]).toEqual({
      dsn: DSN,
      release: undefined,
    });
    expect(sdk.flush.calls).toHaveLength(1);
    const report = sdk.capture.calls[0]?.args[0];
    // The exception itself, so its stack groups the issue in the bug catcher.
    expect(report?.error).toBe(crash);
    expect(report?.fingerprint).toEqual([]);
    expect(report?.tags).toEqual({
      harness: "payment sandbox e2e",
      target: "stripe",
    });
  });

  it("does not re-initialize when the SDK is already up", async () => {
    using _url = withSentryUrl(DSN);
    using sdk = withStubbedSdk({ alreadyUp: true });

    await reportCrash("payment sandbox e2e", "free", new Error("boom"));

    expect(sdk.init.calls).toHaveLength(0);
    expect(sdk.capture.calls).toHaveLength(1);
  });

  it("warns and swallows when the report cannot be sent", async () => {
    using _url = withSentryUrl(DSN);
    using _sdk = withStubbedSdk({ refused: true });
    using warns = stub(console, "warn");

    await reportCrash("email sandbox e2e", "resend", new Error("boom"));

    const lines = warns.calls.map((call) => String(call.args[0])).join("\n");
    expect(lines).toContain("failed to report to the bug catcher");
  });
});
