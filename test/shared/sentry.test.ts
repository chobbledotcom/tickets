import * as Sentry from "@sentry/deno";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { ErrorCode, formatErrorMessage } from "#shared/logger.ts";
import {
  captureServerError,
  initSentry,
  releaseFromCommit,
  resetSentryForTest,
  sendSentryTest,
} from "#shared/sentry.ts";
import { setTestEnv } from "#test-utils/env.ts";

const DSN = "https://abc123@bugs.example.test/2";

/** Decode a fetch body (string or Uint8Array) into a string for assertions. */
const bodyText = (body: BodyInit | null | undefined): string =>
  typeof body === "string"
    ? body
    : new TextDecoder().decode(body as Uint8Array);

describe("sentry", () => {
  let fetchStub: ReturnType<typeof stub<typeof globalThis, "fetch">>;
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    fetchStub.restore();
    restoreEnv?.();
    restoreEnv = undefined;
    // Detach the client so the global Sentry state never leaks into other files.
    resetSentryForTest();
  });

  const firstFetchBody = (): string => {
    const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
    return bodyText(options.body);
  };

  const useHungTransport = async (): Promise<void> => {
    restoreEnv = setTestEnv({ SENTRY_URL: DSN });
    await initSentry();
    fetchStub.restore();
    fetchStub = stub(
      globalThis,
      "fetch",
      () => new Promise<Response>(() => {}),
    );
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
      restoreEnv = setTestEnv({ SENTRY_URL: undefined });
      expect(await initSentry()).toBe(false);
    });

    test("initializes when SENTRY_URL is set", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      expect(await initSentry()).toBe(true);
    });

    test("starts the manual SDK client", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      const initSpy = spy(Sentry.DenoClient.prototype, "init");
      try {
        expect(await initSentry()).toBe(true);
        expect(initSpy.calls.length).toBe(1);
      } finally {
        initSpy.restore();
      }
    });

    test("is idempotent once initialized", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      expect(await initSentry()).toBe(true);
      expect(await initSentry()).toBe(true);
    });

    test("never samples traces — the SDK exists to capture errors only", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      await initSentry();
      expect(Sentry.getClient()?.getOptions().tracesSampleRate).toBe(0);
    });

    test("loads no default integrations", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      await initSentry();
      expect(Sentry.getClient()?.getOptions().integrations).toEqual([]);
    });
  });

  describe("captureServerError", () => {
    const captureDbErrorBody = async (): Promise<string> => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      await initSentry();
      await captureServerError({ code: ErrorCode.DB_QUERY });
      return firstFetchBody();
    };

    test("does nothing when Sentry is not initialized", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: undefined });
      await captureServerError({ code: ErrorCode.DB_QUERY });
      expect(fetchStub.calls.length).toBe(0);
    });

    test("captures the original exception with its stack trace", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
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
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      await initSentry();

      const context = { code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" };
      await captureServerError(context);

      expect(fetchStub.calls.length).toBe(1);
      const body = firstFetchBody();
      expect(body).toContain(formatErrorMessage(context));
    });

    test("tags the event with listing and attendee ids", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
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
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
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

    test("does not add empty extra context", async () => {
      expect(await captureDbErrorBody()).not.toContain('"extra"');
    });

    test("honours the endpoint retry-after limit", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      fetchStub.restore();
      fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(
          new Response(null, {
            headers: { "retry-after": "60" },
            status: 429,
          }),
        ),
      );
      await initSentry();

      await captureServerError({ code: ErrorCode.DB_QUERY });
      await captureServerError({ code: ErrorCode.DB_QUERY });

      expect(fetchStub.calls.length).toBe(1);
    });

    test("gives up on a hung transport after the flush timeout, not sooner", async () => {
      await useHungTransport();
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
      restoreEnv = setTestEnv({ SENTRY_URL: undefined });
      expect(await sendSentryTest()).toBe(false);
      expect(fetchStub.calls.length).toBe(0);
    });

    test("sends a tagged test error with its stack trace", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
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
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      for (const [status, accepted] of [
        [199, false],
        [200, true],
        [299, true],
        [300, false],
        [403, false],
      ] as const) {
        fetchStub.restore();
        fetchStub = stub(globalThis, "fetch", () =>
          Promise.resolve(responseWithStatus(status)),
        );
        expect(await sendSentryTest()).toBe(accepted);
      }
    });

    test("returns false when the Sentry request fails", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      fetchStub.restore();
      fetchStub = stub(globalThis, "fetch", () =>
        Promise.reject(new Error("network failed")),
      );

      expect(await sendSentryTest()).toBe(false);
      expect(fetchStub.calls.length).toBe(1);
    });

    test("keeps the result tied to its event", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      await initSentry();
      const client = Sentry.getClient();
      if (!client) throw new Error("Expected initialized Sentry client");

      let finishFetch = (_response: Response): void => {};
      fetchStub.restore();
      fetchStub = stub(
        globalThis,
        "fetch",
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
      await useHungTransport();

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
