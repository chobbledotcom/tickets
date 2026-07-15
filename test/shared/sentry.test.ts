import * as Sentry from "@sentry/deno";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { ErrorCode, formatErrorMessage } from "#shared/logger.ts";
import {
  captureServerError,
  initSentry,
  releaseFromCommit,
  resetSentryForTest,
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
      const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      return bodyText(options.body);
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
      const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      const body = bodyText(options.body);
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

      const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      const body = bodyText(options.body);
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

      const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      expect(bodyText(options.body)).toContain(
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
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      await initSentry();
      // A transport that never settles: capture must still resolve — after
      // the 2s flush timeout, not immediately (a zero timeout would report
      // "flushed" before the transport had any chance to deliver). The SDK
      // first finishes client processing, then gives the transport exactly 2s.
      fetchStub.restore();
      fetchStub = stub(
        globalThis,
        "fetch",
        () => new Promise<Response>(() => {}),
      );

      const time = new FakeTime();
      try {
        const state = { settled: false };
        const pending = captureServerError({
          code: ErrorCode.DB_QUERY,
        }).finally(() => {
          state.settled = true;
        });
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
});
