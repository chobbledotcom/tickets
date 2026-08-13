import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { logRefundLedgerError } from "#shared/refund-ledger/log.ts";
import { initSentry } from "#shared/sentry.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { resetSentry } from "#test-utils/sentry.ts";

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
    await runWithPendingWork(() => {
      logRefundLedgerError({
        attendeeId: 17,
        error: failure,
        kind: "single_post",
      });
      return Promise.resolve();
    });

    expect(errors.lastMessage()).toContain("Refund ledger post failed");
    expect(errors.lastMessage()).toContain("attendee=17");
    expect(errors.lastMessage()).not.toContain(failure.message);

    const sentryCall = fetchStub.calls.find((call) =>
      String(call.args[0]).includes("bugs.example.test"),
    );
    if (sentryCall === undefined) throw new Error("Sentry was not called");
    const options = sentryCall.args[1] as RequestInit;
    const body =
      typeof options.body === "string"
        ? options.body
        : new TextDecoder().decode(options.body as Uint8Array);
    expect(body).toContain('"value":"ledger backend failed"');
    expect(body).toContain("stacktrace");
    expect(body).toContain('"detail":"Refund ledger post failed"');
    expect(body).toContain('"attendeeId":"17"');
  });
});
