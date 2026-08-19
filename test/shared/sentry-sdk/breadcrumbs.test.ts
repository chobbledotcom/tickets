// test-groups: run-alone — the SDK instruments the global fetch once per
// process, on the first client it sets up. Sharing an isolate would let
// another suite decide that before this file installs its fetch stub.
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { ErrorCode } from "#shared/logger.ts";
import { captureServerError, initSentry } from "#shared/sentry.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { resetSentry } from "#test-utils/sentry.ts";

const DSN = "https://key@bugs.example.test/1";

/**
 * The SDK instruments the global fetch once per process, on the first client
 * it sets up. These tests therefore live in their own file: a suite that had
 * already started a client would have instrumented — or not instrumented — the
 * global fetch before the stub below was ever installed, and the assertions
 * would stop meaning anything.
 */
describe("report breadcrumbs", () => {
  afterEach(resetSentry);

  // An outbound URL can carry a checkout session id, so the calls we make are
  // deliberately not recorded. The console lines are.
  test("keeps the console lines but not the outbound calls", async () => {
    using _env = withEnv({ SENTRY_URL: DSN });
    using fetchStub = stubFetch(() => new Response("{}", { status: 200 }));
    await initSentry();

    console.debug("a line worth keeping");
    await fetch("https://provider.example.test/checkout/cs_live_secret");
    await captureServerError({ code: ErrorCode.DB_QUERY });

    const sentryCall = fetchStub.calls.find((call) =>
      String(call.args[0]).includes("bugs.example.test"),
    );
    const body = String((sentryCall!.args[1] as RequestInit).body);
    expect(body).toContain("a line worth keeping");
    expect(body).not.toContain("cs_live_secret");
    expect(body).not.toContain('"category":"fetch"');
  });

  test("does not record its own reports as breadcrumbs", async () => {
    using _env = withEnv({ SENTRY_URL: DSN });
    using fetchStub = stubFetch(() => new Response("{}", { status: 200 }));
    await initSentry();

    await captureServerError({ code: ErrorCode.EMAIL_SEND });
    await captureServerError({ code: ErrorCode.DB_QUERY });

    const body = String((fetchStub.calls[1]!.args[1] as RequestInit).body);
    expect(body).not.toContain('"category":"sentry"');
  });
});
