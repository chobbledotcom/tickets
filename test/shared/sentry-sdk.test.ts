import * as Sentry from "@sentry/deno";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { ErrorCode } from "#shared/logger.ts";
import { runWithRequestTrace } from "#shared/request-trace.ts";
import "#shared/sentry-sdk.ts";
import { captureServerError, initSentry } from "#shared/sentry.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { resetSentry } from "#test-utils/sentry.ts";

const DSN = "https://key@bugs.example.test/1";

const requireClient = () => {
  const client = Sentry.getClient();
  if (!client) throw new Error("Sentry client was not created");
  return client;
};

describe("Sentry SDK transport", () => {
  afterEach(resetSentry);

  test("starts the manual SDK client", async () => {
    using _env = withEnv({ SENTRY_URL: DSN });
    const initSpy = spy(Sentry.DenoClient.prototype, "init");
    try {
      await initSentry();

      expect(initSpy.calls).toHaveLength(1);
    } finally {
      initSpy.restore();
    }
  });

  test("does not sample traces", async () => {
    using _env = withEnv({ SENTRY_URL: DSN });
    await initSentry();

    expect(requireClient().getOptions().tracesSampleRate).toBe(0);
  });

  test("counts one external subrequest per envelope", async () => {
    using _env = withEnv({
      SENTRY_URL: DSN,
    });
    using fetchStub = stubFetch(new Response(null, { status: 200 }));

    await runWithSubrequestBudget(async () => {
      expect(await initSentry()).toBe(true);
      await captureServerError({ code: ErrorCode.DB_QUERY });
      expect(getSubrequestUsage()).toEqual({
        database: 0,
        external: 1,
        total: 1,
      });
    });
    expect(fetchStub.calls).toHaveLength(1);
  });

  test("uses the exact HTTP transport and forwards rate-limit headers", async () => {
    using _env = withEnv({ SENTRY_URL: DSN });
    using fetchStub = stubFetch(
      new Response(null, {
        headers: {
          "retry-after": "17",
          "x-sentry-rate-limits": "60:error",
        },
        status: 202,
      }),
    );
    await initSentry();
    const client = requireClient();
    const responseReady = Promise.withResolvers<{
      headers?: Record<string, string | null>;
      statusCode?: number;
    }>();
    const stopListening = client.on("afterSendEvent", (_event, response) => {
      responseReady.resolve(response);
    });
    try {
      await captureServerError({ code: ErrorCode.DB_QUERY });

      const options = fetchStub.calls[0]!.args[1] as RequestInit;
      expect(options.method).toBe("POST");
      expect(options.referrerPolicy).toBe("strict-origin");
      expect(await responseReady.promise).toEqual({
        headers: {
          "retry-after": "17",
          "x-sentry-rate-limits": "60:error",
        },
        statusCode: 202,
      });
    } finally {
      stopListening();
    }
  });

  test("names a blocked Sentry transport request", async () => {
    using _env = withEnv({ SENTRY_URL: DSN });
    await initSentry();
    const client = requireClient();
    const transport = client.getTransport();
    if (!transport) throw new Error("Sentry transport was not created");
    const envelope: Parameters<typeof transport.send>[0] = [
      { event_id: "budget-event", sent_at: "2026-07-19T00:00:00.000Z" },
      [
        [
          { type: "event" },
          { event_id: "budget-event", message: "Budget event", timestamp: 0 },
        ],
      ],
    ];

    await expect(
      runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 50, external: 0, total: 0 }, () =>
          transport.send(envelope),
        ),
      ),
    ).rejects.toThrow("Blocked external operation: Sentry transport");
  });

  /**
   * The scope carries everything that makes a report findable: what happened,
   * where, on which site, and how to group it. Each of these assertions fails
   * if the matching scope call stops running.
   */
  describe("the scope a report carries", () => {
    const captureAndRead = async (
      capture: () => Promise<void>,
    ): Promise<string> => {
      using fetchStub = stubFetch(() => new Response("{}", { status: 200 }));
      await initSentry();
      await capture();
      const options = fetchStub.calls[0]!.args[1] as RequestInit;
      return typeof options.body === "string"
        ? options.body
        : new TextDecoder().decode(options.body as Uint8Array);
    };

    /** A report with no exception: the 72-of-82 call sites that pass a code. */
    const messageReportBody = (): Promise<string> =>
      captureAndRead(() => captureServerError({ code: ErrorCode.DB_QUERY }));

    /** A report that carries the exception that caused it. */
    const errorReportBody = (): Promise<string> =>
      captureAndRead(() =>
        captureServerError({
          code: ErrorCode.DB_QUERY,
          error: new Error("kaboom"),
        }),
      );

    test("marks the report as an error, tags it, and names its route", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });

      const body = await captureAndRead(() =>
        runWithRequestTrace(
          new Request("https://venue.example.com/admin/listings/42"),
          () =>
            captureServerError({
              code: ErrorCode.DB_QUERY,
              detail: "select failed",
              listingId: 42,
            }),
        ),
      );

      expect(body).toContain('"level":"error"');
      expect(body).toContain('"code":"E_DB_QUERY"');
      expect(body).toContain('"listingId":"42"');
      expect(body).toContain('"extra":{"detail":"select failed"}');
      expect(body).toContain('"transaction":"GET /admin/listings/[id]"');
    });

    test("groups a report with no stack even outside a request", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });

      expect(await messageReportBody()).toContain(
        '"fingerprint":["E_DB_QUERY"]',
      );
    });

    test("leaves a report that carries a stack trace ungrouped", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });

      expect(await errorReportBody()).not.toContain("fingerprint");
    });

    test("sends an attached error as an exception, not as prose", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });

      const body = await errorReportBody();
      expect(body).toContain('"stacktrace"');
      expect(body).not.toContain('"message":"Error: Database query failed"');
    });

    test("sends a report with no error as a message", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });

      const body = await messageReportBody();
      expect(body).toContain('"message":"Error: Database query failed"');
      expect(body).not.toContain('"stacktrace"');
    });
  });
});
