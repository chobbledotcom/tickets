import * as Sentry from "@sentry/deno";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  ErrorCode,
  formatErrorMessage,
  runWithRequestId,
} from "#shared/logger.ts";
import { runWithRequestTrace } from "#shared/request-trace.ts";
import {
  captureServerError,
  initSentry,
  releaseFromCommit,
  sendSentryTest,
} from "#shared/sentry.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { resetSentry } from "#test-utils/sentry.ts";

const DSN = "https://abc123@bugs.example.test/2";

/** Decode a fetch body (string or Uint8Array) into a string for assertions. */
const bodyText = (body: BodyInit | null | undefined): string =>
  typeof body === "string"
    ? body
    : new TextDecoder().decode(body as Uint8Array);

describe("sentry", () => {
  let fetchStub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchStub = stubFetch(() => new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    fetchStub.restore();
    // Detach the client so the global Sentry state never leaks into other files.
    resetSentry();
  });

  const firstFetchBody = (): string => {
    const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
    return bodyText(options.body);
  };

  const useHungTransport = async (): Promise<EnvScope> => {
    const env = withEnv({ SENTRY_URL: DSN });
    await initSentry();
    fetchStub.restore();
    fetchStub = stubFetch(() => new Promise<Response>(() => {}));
    return env;
  };

  const trackSettlement = <T>(pending: Promise<T>) => {
    const state = { settled: false };
    return {
      pending: pending.finally(() => {
        state.settled = true;
      }),
      state,
    };
  };

  const responseWithStatus = (status: number): Response => {
    const response = Response.error();
    Object.defineProperty(response, "status", { value: status });
    return response;
  };

  describe("releaseFromCommit", () => {
    test("prefixes the commit SHA with the project name", () => {
      expect(releaseFromCommit("deadbeef")).toBe("chobble-tickets@deadbeef");
    });

    test("is undefined when no commit is baked in (dev builds)", () => {
      expect(releaseFromCommit("")).toBeUndefined();
    });
  });

  describe("initSentry", () => {
    test("does not initialize when SENTRY_URL is unset", async () => {
      using _env = withEnv({ SENTRY_URL: undefined });
      expect(await initSentry()).toBe(false);
    });

    test("initializes when SENTRY_URL is set", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      expect(await initSentry()).toBe(true);
    });

    test("starts the manual SDK client", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      const initSpy = spy(Sentry.DenoClient.prototype, "init");
      try {
        expect(await initSentry()).toBe(true);
        expect(initSpy.calls.length).toBe(1);
      } finally {
        initSpy.restore();
      }
    });

    test("is idempotent once initialized", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      expect(await initSentry()).toBe(true);
      expect(await initSentry()).toBe(true);
    });

    test("never samples traces — the SDK exists to capture errors only", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();
      expect(Sentry.getClient()?.getOptions().tracesSampleRate).toBe(0);
    });

    // Constructing DenoClient directly adds no integrations, so the two that
    // put information into a report have to be named. A deployment that loads
    // neither reports wrapper errors with no cause and no console trail.
    test("loads the integrations that add information to a report", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      const names = (Sentry.getClient()?.getOptions().integrations ?? []).map(
        (integration) => integration.name,
      );
      expect(names).toEqual(["Breadcrumbs", "LinkedErrors"]);
    });

    // Dedupe drops an error that repeats. Two requests hitting one bug are two
    // real occurrences, so dropping the second undercounts the problem.
    test("does not load the integration that drops repeated errors", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await captureServerError({ code: ErrorCode.DB_QUERY });
      await captureServerError({ code: ErrorCode.DB_QUERY });

      expect(fetchStub.calls.length).toBe(2);
    });
  });

  describe("captureServerError", () => {
    const captureDbErrorBody = async (): Promise<string> => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();
      await captureServerError({ code: ErrorCode.DB_QUERY });
      return firstFetchBody();
    };

    test("does nothing when Sentry is not initialized", async () => {
      using _env = withEnv({ SENTRY_URL: undefined });
      await captureServerError({ code: ErrorCode.DB_QUERY });
      expect(fetchStub.calls.length).toBe(0);
    });

    test("captures the original exception with its stack trace", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await captureServerError({
        code: ErrorCode.CDN_REQUEST,
        detail: "GET /thing: kaboom",
        error: new Error("kaboom"),
      });

      expect(fetchStub.calls.length).toBe(1);
      const [url, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      expect(url).toContain("bugs.example.test");
      expect(url).toContain("/api/2/envelope/");
      expect(options.method).toBe("POST");
      expect(options.referrerPolicy).toBe("strict-origin");
      const body = bodyText(options.body);
      // Real exception with a stack trace, not just a flat message.
      expect(body).toContain("kaboom");
      expect(body).toContain("stacktrace");
      // Classified code travels as a tag, detail as extra context.
      expect(body).toContain(ErrorCode.CDN_REQUEST);
      expect(body).toContain("GET /thing: kaboom");
    });

    test("sends the formatted message when no exception is attached", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      const context = { code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" };
      await captureServerError(context);

      expect(fetchStub.calls.length).toBe(1);
      const body = firstFetchBody();
      expect(body).toContain(formatErrorMessage(context));
    });

    test("tags the event with listing and attendee ids", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await captureServerError({
        attendeeId: 99,
        code: ErrorCode.NOT_FOUND_ATTENDEE,
        listingId: 42,
      });

      const body = firstFetchBody();
      expect(body).toContain('"listingId":"42"');
      expect(body).toContain('"attendeeId":"99"');
    });

    test("carries the detail as structured extra context, not just prose", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      // The exact serialized shape: an event whose stack-trace source context
      // merely mentions the string would not satisfy this.
      await captureServerError({
        code: ErrorCode.CDN_REQUEST,
        detail: "structured-detail-marker",
        error: new Error("kaboom"),
      });

      expect(firstFetchBody()).toContain(
        '"extra":{"detail":"structured-detail-marker"}',
      );
    });

    test("marks the event as level error", async () => {
      const levels =
        (await captureDbErrorBody()).match(/"level":"[^"]*"/g) ?? [];
      expect(levels).toContain('"level":"error"');
      expect(levels).not.toContain('"level":"info"');
    });

    // Regression: an error's cause was dropped, so every database failure was
    // reported as the wrapper that caught it, with the real failure missing.
    test("keeps the root cause of a wrapped error", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      const cause = new Error("connection reset by peer");
      await captureServerError({
        code: ErrorCode.DB_QUERY,
        error: new Error("libsql execute failed", { cause }),
      });

      const body = firstFetchBody();
      expect(body).toContain("libsql execute failed");
      expect(body).toContain("connection reset by peer");
    });

    test("keeps the console lines printed before the error", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      console.debug("a line worth keeping");
      await captureServerError({ code: ErrorCode.DB_QUERY });

      expect(firstFetchBody()).toContain("a line worth keeping");
    });

    test("names the site and the route the error happened on", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await runWithRequestTrace(
        new Request("https://venue.example.com/admin/listings/42"),
        () => captureServerError({ code: ErrorCode.DB_QUERY }),
      );

      const body = firstFetchBody();
      expect(body).toContain('"transaction":"GET /admin/listings/[id]"');
      expect(body).toContain('"site":"venue.example.com"');
      expect(body).toContain(
        '"url":"https://venue.example.com/admin/listings/[id]"',
      );
    });

    // The ticket token is the whole credential for that ticket. It must never
    // reach the reporter, in the route, the URL, or the query string.
    test("never reports a ticket token", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await runWithRequestTrace(
        new Request("https://venue.example.com/t/9D5F57B232?email=a@b.test"),
        () => captureServerError({ code: ErrorCode.NOT_FOUND_ATTENDEE }),
      );

      const body = firstFetchBody();
      expect(body).not.toContain("9D5F57B232");
      expect(body).not.toContain("a@b.test");
      expect(body).toContain('"transaction":"GET /t/[redacted]"');
    });

    // A blank tag is worse than a missing one: it shows up in the tag list and
    // filters to nothing. Outside a request there is no id, route, or URL.
    test("leaves out the tags it has no value for", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await captureServerError({ code: ErrorCode.DB_QUERY });

      const body = firstFetchBody();
      expect(body).not.toContain("requestId");
      expect(body).not.toContain('"url"');
      expect(body).not.toContain("listingId");
      expect(body).not.toContain("attendeeId");
      expect(body).toContain('"code":"E_DB_QUERY"');
    });

    // Boot and scheduled runs report outside any request, and still have to say
    // which site they came from.
    test("names the site from its own settings when there is no request", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await captureServerError({ code: ErrorCode.DB_QUERY });

      expect(firstFetchBody()).toContain(
        `"site":${JSON.stringify(getEffectiveDomain())}`,
      );
    });

    test("carries the request id the console lines carry", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await runWithRequestId(() =>
        captureServerError({ code: ErrorCode.DB_QUERY }),
      );

      const requestIds =
        firstFetchBody().match(/"requestId":"([0-9a-f]{4})"/) ?? [];
      expect(requestIds[1]).toMatch(/^[0-9a-f]{4}$/);
    });

    // Grouping a message report by its text made one issue per varying detail:
    // forty "Broken image" issues instead of one issue with forty events.
    test("groups message reports by code and route, not by their detail", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await runWithRequestTrace(
        new Request("https://venue.example.com/admin/listings/42"),
        () =>
          captureServerError({
            code: ErrorCode.IMAGE_BROKEN,
            detail: "image 4821 missing",
          }),
      );

      expect(firstFetchBody()).toContain(
        '"fingerprint":["E_IMAGE_BROKEN","GET","/admin/listings/[id]"]',
      );
    });

    // A stack trace groups better than anything we could invent, so an error
    // report must keep the SDK's own grouping.
    test("leaves grouping alone for a report that carries a stack trace", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();

      await captureServerError({
        code: ErrorCode.DB_QUERY,
        error: new Error("kaboom"),
      });

      expect(firstFetchBody()).not.toContain('"fingerprint"');
    });

    test("does not add empty extra context", async () => {
      expect(await captureDbErrorBody()).not.toContain('"extra"');
    });

    test("honours the endpoint retry-after limit", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      fetchStub.restore();
      fetchStub = stubFetch(
        new Response(null, {
          headers: { "retry-after": "60" },
          status: 429,
        }),
      );
      await initSentry();

      await captureServerError({ code: ErrorCode.DB_QUERY });
      await captureServerError({ code: ErrorCode.DB_QUERY });

      expect(fetchStub.calls.length).toBe(1);
    });

    test("gives up on a hung transport after the flush timeout, not sooner", async () => {
      using _env = await useHungTransport();
      // A transport that never settles: capture must still resolve — after
      // the 2s flush timeout, not immediately (a zero timeout would report
      // "flushed" before the transport had any chance to deliver). The SDK
      // first finishes client processing, then gives the transport exactly 2s.
      const time = new FakeTime();
      try {
        const { pending, state } = trackSettlement(
          captureServerError({ code: ErrorCode.DB_QUERY }),
        );
        await time.nextAsync();
        await time.tickAsync(1998);
        await time.runMicrotasks();
        expect(state.settled).toBe(false);
        await time.tickAsync(1);
        await time.runMicrotasks();
        expect(state.settled).toBe(false);
        await time.tickAsync(1);
        await time.runMicrotasks();
        expect(state.settled).toBe(true);
        await pending;
      } finally {
        time.restore();
      }
    });
  });

  describe("sendSentryTest", () => {
    test("returns false without loading Sentry when it is not configured", async () => {
      using _env = withEnv({ SENTRY_URL: undefined });
      expect(await sendSentryTest()).toBe(false);
      expect(fetchStub.calls.length).toBe(0);
    });

    test("sends a tagged test error with its stack trace", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      expect(await sendSentryTest()).toBe(true);
      expect(fetchStub.calls.length).toBe(1);
      const body = firstFetchBody();
      expect(body).toContain(
        '"value":"Test Sentry notification from the admin debug page."',
      );
      expect(body).toContain('"source":"admin-debug"');
      expect(body).toContain('"test":"true"');
      expect(body).toContain("stacktrace");
    });

    test("accepts only a 2xx Sentry response", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      for (const [status, accepted] of [
        [199, false],
        [200, true],
        [299, true],
        [300, false],
        [403, false],
      ] as const) {
        fetchStub.restore();
        fetchStub = stubFetch(responseWithStatus(status));
        expect(await sendSentryTest()).toBe(accepted);
      }
    });

    test("returns false when the Sentry request fails", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      fetchStub.restore();
      fetchStub = stubFetch(new Error("network failed"));

      expect(await sendSentryTest()).toBe(false);
      expect(fetchStub.calls.length).toBe(1);
    });

    test("keeps the result tied to its event", async () => {
      using _env = withEnv({ SENTRY_URL: DSN });
      await initSentry();
      const client = Sentry.getClient();
      if (!client) throw new Error("Expected initialized Sentry client");

      let finishFetch = (_response: Response): void => {};
      fetchStub.restore();
      fetchStub = stubFetch(
        () =>
          new Promise<Response>((resolve) => {
            finishFetch = resolve;
          }),
      );
      const eventReady = Promise.withResolvers<Sentry.Event>();
      const stopCapturing = client.on("beforeSendEvent", (event) =>
        eventReady.resolve(event),
      );
      try {
        const { pending, state } = trackSettlement(sendSentryTest());
        const event = await eventReady.promise;
        client.emit(
          "afterSendEvent",
          { ...event, event_id: "another-event" },
          { statusCode: 200 },
        );
        await Promise.resolve();
        expect(state.settled).toBe(false);

        finishFetch(new Response(null, { status: 200 }));
        expect(await pending).toBe(true);
        const clearTimeoutSpy = spy(globalThis, "clearTimeout");
        try {
          client.emit("afterSendEvent", event, { statusCode: 200 });
          expect(clearTimeoutSpy.calls.length).toBe(0);
        } finally {
          clearTimeoutSpy.restore();
        }
      } finally {
        stopCapturing();
      }
    });

    test("returns false when the Sentry test times out", async () => {
      using _env = await useHungTransport();

      const time = new FakeTime();
      try {
        const { pending, state } = trackSettlement(sendSentryTest());
        await time.runMicrotasks();
        await time.tickAsync(1999);
        expect(state.settled).toBe(false);
        await time.tickAsync(1);
        await time.runMicrotasks();
        expect(state.settled).toBe(true);
        expect(await pending).toBe(false);
      } finally {
        time.restore();
      }
    });
  });
});
