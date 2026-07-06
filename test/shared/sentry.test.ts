import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ErrorCode, formatErrorMessage } from "#shared/logger.ts";
import {
  captureServerError,
  initSentry,
  releaseFromCommit,
  resetSentryForTest,
} from "#shared/sentry.ts";
import { setTestEnv } from "#test-utils";

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
    test("does not initialize when SENTRY_URL is unset", () => {
      restoreEnv = setTestEnv({ SENTRY_URL: undefined });
      expect(initSentry()).toBe(false);
    });

    test("initializes when SENTRY_URL is set", () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      expect(initSentry()).toBe(true);
    });

    test("is idempotent once initialized", () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      expect(initSentry()).toBe(true);
      expect(initSentry()).toBe(true);
    });
  });

  describe("captureServerError", () => {
    test("does nothing when Sentry is not initialized", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: undefined });
      await captureServerError({ code: ErrorCode.DB_QUERY });
      expect(fetchStub.calls.length).toBe(0);
    });

    test("captures the original exception with its stack trace", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      initSentry();

      await captureServerError({
        code: ErrorCode.CDN_REQUEST,
        detail: "GET /thing: kaboom",
        error: new Error("kaboom"),
      });

      expect(fetchStub.calls.length).toBe(1);
      const [url, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      expect(url).toContain("bugs.example.test");
      expect(url).toContain("/api/2/envelope/");
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
      initSentry();

      const context = { code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" };
      await captureServerError(context);

      expect(fetchStub.calls.length).toBe(1);
      const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      const body = bodyText(options.body);
      expect(body).toContain(formatErrorMessage(context));
    });

    test("tags the event with listing and attendee ids", async () => {
      restoreEnv = setTestEnv({ SENTRY_URL: DSN });
      initSentry();

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
  });
});
