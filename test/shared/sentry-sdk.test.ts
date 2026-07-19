import * as Sentry from "@sentry/deno";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { ErrorCode } from "#shared/logger.ts";
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
});
