import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import { resetEffectiveDomain } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { resetHostEmailConfig } from "#shared/email.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";
import { setTestEnv } from "./env.ts";

/**
 * Brand a known-valid address as ValidEmail for tests. Throws when the literal
 * is not actually valid, so a typo in a fixture surfaces immediately rather than
 * silently producing a bad value.
 */
export const validEmail = (address: string): ValidEmail => {
  const parsed = parseEmail(address);
  if (!parsed) throw new Error(`Test fixture is not a valid email: ${address}`);
  return parsed;
};

/**
 * The per-describe state shared by the contact-form and support-message unit
 * tests: a `fetch` stub installed on demand, a `setTestEnv` handle the tests
 * can swap mid-test, and a single `teardown` that undoes every side effect
 * `setEnv`/`stubFetch`/`setHostEmailConfigForTest`/`setEffectiveDomainForTest`
 * touched. Owns the mutable `restoreEnv`/`fetchStub` refs so the call sites
 * don't redeclare them — `setEnv` reverts the previous override before
 * applying the next, mirroring the inline `restoreEnv?.(); restoreEnv =
 * setTestEnv(...)` the unit tests used to spell out by hand.
 */
export const emailTestSandbox = () => {
  let restoreEnv: (() => void) | undefined;
  let fetchStub: Stub | undefined;

  /** Set (or override) the test env for this sandbox. The previous override,
   *  if any, is restored first so a mid-test switch from the `beforeEach` env
   *  to a different env leaves no dangling handlers. */
  const setEnv = (env: Record<string, string | undefined>): void => {
    restoreEnv?.();
    restoreEnv = setTestEnv(env);
  };

  /** Install a `fetch` stub delegating to `impl`. Replaces any prior stub. */
  const stubFetch = (
    impl: (url: string, init?: RequestInit) => Promise<Response>,
  ): void => {
    fetchStub?.restore();
    fetchStub = stub(
      globalThis,
      "fetch",
      impl as unknown as typeof globalThis.fetch,
    );
  };

  /** Stub `fetch` with a 200-OK handler that captures the next request's URL
   *  and parsed JSON body, so a test can assert on what was sent. */
  const captureFetchCall = (
    status = 200,
  ): {
    body: Record<string, unknown>;
    url: string;
  } => {
    const captured = { body: {} as Record<string, unknown>, url: "" };
    stubFetch((url, init) => {
      captured.url = url;
      captured.body = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(null, { status }));
    });
    return captured;
  };

  /** Tear down everything the sandbox touched: the fetch stub, host email
   *  config, effective domain, settings overrides, and env overrides. Call
   *  from `afterEach`. */
  const teardown = (): void => {
    fetchStub?.restore();
    fetchStub = undefined;
    resetHostEmailConfig();
    resetEffectiveDomain();
    settings.clearTestOverrides();
    restoreEnv?.();
    restoreEnv = undefined;
  };

  return {
    captureFetchCall,
    /** The current `fetch` stub, so tests can assert on `stub.calls.length`. */
    get fetchStub(): Stub | undefined {
      return fetchStub;
    },
    setEnv,
    stubFetch,
    teardown,
  };
};

/** Stub fetch to reject, call `sendFn`, and assert it returned `false` with
 *  zero fetch calls. Used by contact-form and support-message tests that
 *  verify a noop path (no provider configured, no business email, etc.). */
export const expectSendNoop = async (
  sandbox: ReturnType<typeof emailTestSandbox>,
  sendFn: () => Promise<boolean>,
): Promise<void> => {
  sandbox.stubFetch(() => Promise.reject(new Error("should not be called")));
  expect(await sendFn()).toBe(false);
  expect(sandbox.fetchStub?.calls.length).toBe(0);
};
