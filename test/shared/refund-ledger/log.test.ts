import { assert, assertStringIncludes } from "@std/assert";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { logRefundLedgerError } from "#shared/refund-ledger/log.ts";
import { initSentry } from "#shared/sentry.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { resetSentry, sentryRequestBody } from "#test-utils/sentry.ts";

describe("refund ledger diagnostics", () => {
  const errors = setupErrorSpy();

  afterEach(resetSentry);

  test("keeps console detail safe and sends the caught stack to Sentry", async () => {
    using _env = withEnv({
      NTFY_URL: undefined,
      SENTRY_URL: "https://ledger@bugs.example.test/2",
    });
    using fetchStub = stubFetch(() => new Response("{}", { status: 200 }));
    const failure = new Error("ledger backend failed");

    await initSentry();
    await withRequestContext(() => {
      logRefundLedgerError({
        attendeeId: 17,
        error: failure,
        kind: "single_post",
      });
      return Promise.resolve();
    });

    assertStringIncludes(
      errors.lastMessage() ?? "",
      "Refund ledger post failed",
    );
    assertStringIncludes(errors.lastMessage() ?? "", "attendee=17");
    assert(
      errors.lastMessage()?.includes(failure.message) === false,
      "the value should not contain the searched item",
    );

    const body = sentryRequestBody(fetchStub.calls);
    assertStringIncludes(body, '"value":"ledger backend failed"');
    assertStringIncludes(body, "stacktrace");
    assertStringIncludes(body, '"detail":"Refund ledger post failed"');
    assertStringIncludes(body, '"attendeeId":"17"');
  });
});
