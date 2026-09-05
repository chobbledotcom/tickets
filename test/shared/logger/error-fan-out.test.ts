import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Spy, spy } from "@std/testing/mock";
import {
  ErrorCode,
  logError,
  logErrorLocal,
  runWithRequestId,
  withDeferredErrorReports,
} from "#shared/logger.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const NTFY_URL = "https://ntfy.example.test/errors";

/**
 * An error report fans out to the notifier, the activity log, and Sentry. The
 * ntfy call is the one visible from a unit test without a database, so it
 * stands in for "the report went out".
 */
describe("error fan-out", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  let errorSpy: Spy;

  beforeEach(() => {
    fetchStub = stubFetch(() => new Response("ok", { status: 200 }));
    errorSpy = spy(console, "error");
  });

  afterEach(() => {
    fetchStub.restore();
    errorSpy.restore();
  });

  const ntfyCalls = (): number =>
    fetchStub.calls.filter((call) => String(call.args[0]).includes("ntfy"))
      .length;
  const operatorError = {
    code: ErrorCode.EMAIL_SEND,
    detail: "provider=postmark status=422",
    operatorDetail: "Suppressed recipient boss@example.com",
  } as const;
  const firstErrorLine = (): string => String(errorSpy.calls[0]?.args[0]);
  const expectOperatorDetailHidden = (line: string): void => {
    expect(line).not.toContain("Suppressed");
    expect(line).not.toContain("boss@example.com");
  };

  test("writes the console line for every error", () => {
    logError({ code: ErrorCode.DB_QUERY, detail: "select failed" });

    expect(errorSpy.calls.length).toBe(1);
  });

  // Without the spaces the line reads "[Error] E_DB_QUERYlisting=7", which no
  // log search would match on either half.
  test("separates the parts of the console line with spaces", () => {
    logError({ code: ErrorCode.DB_QUERY, detail: "boom", listingId: 7 });

    expect(String(errorSpy.calls[0]?.args[0])).toBe(
      '[Error] E_DB_QUERY listing=7 detail="boom"',
    );
  });

  test("does not promise an activity-log copy outside a request", () => {
    logError(operatorError);

    const line = firstErrorLine();
    expect(line).toContain('detail="provider=postmark status=422"');
    expect(line).not.toContain("operatorDetail");
    expectOperatorDetailHidden(line);
  });

  test("marks operator detail when its activity-log copy is queued", async () => {
    await runWithRequestId(async () => {
      logError(operatorError);

      const line = firstErrorLine();
      expect(line).toContain('operatorDetail="(activity log)"');
      expectOperatorDetailHidden(line);
    });
  });

  test("does not mark operator detail for local-only errors", async () => {
    await runWithRequestId(async () => {
      logErrorLocal(operatorError);
      expect(firstErrorLine()).not.toContain("operatorDetail");
    });
  });

  test("omits the operator marker when there is no operator-only detail", () => {
    logError({ code: ErrorCode.DB_QUERY, detail: "boom" });

    expect(String(errorSpy.calls[0]?.args[0])).not.toContain("operatorDetail");
  });

  test("sends the report out from inside a request", async () => {
    using _env = withEnv({ NTFY_URL });

    await runWithRequestId(async () => {
      logError({ code: ErrorCode.DB_QUERY });
    });

    expect(ntfyCalls()).toBe(1);
  });

  // Outside a request there is no queue to hold the work, and Bunny kills a
  // fetch made after the response, so the report stays on the console.
  test("does not send the report out when there is no request", () => {
    using _env = withEnv({ NTFY_URL });

    logError({ code: ErrorCode.DB_QUERY });

    expect(ntfyCalls()).toBe(0);
    expect(errorSpy.calls.length).toBe(1);
  });

  test("holds a deferred report until the critical work has finished", async () => {
    using _env = withEnv({ NTFY_URL });

    await runWithRequestId(async () => {
      await withDeferredErrorReports(async () => {
        logError({ code: ErrorCode.DB_QUERY });
        expect(ntfyCalls()).toBe(0);
      });
    });

    expect(ntfyCalls()).toBe(1);
  });

  test("sends every deferred report, not just the last", async () => {
    using _env = withEnv({ NTFY_URL });

    await runWithRequestId(async () => {
      await withDeferredErrorReports(async () => {
        logError({ code: ErrorCode.DB_QUERY });
        logError({ code: ErrorCode.EMAIL_SEND });
      });
    });

    expect(ntfyCalls()).toBe(2);
  });
});
