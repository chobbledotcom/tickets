// jscpd:ignore-start
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { logRefundLedgerError } from "#shared/refund-ledger/log.ts";
import { initSentry } from "#shared/sentry.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { says, saysNot } from "#test-utils/says.ts";
import { resetSentry, sentryRequestBody } from "#test-utils/sentry.ts";

// jscpd:ignore-end

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

    says(errors.lastMessage(), "Refund ledger post failed");
    says(errors.lastMessage(), "attendee=17");
    saysNot(errors.lastMessage(), failure.message);

    const body = sentryRequestBody(fetchStub.calls);
    says(body, '"value":"ledger backend failed"');
    says(body, "stacktrace");
    says(body, '"detail":"Refund ledger post failed"');
    says(body, '"attendeeId":"17"');
  });
});
