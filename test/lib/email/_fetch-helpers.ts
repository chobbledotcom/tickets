/**
 * Shared fetch stubbing helpers for email tests.
 *
 * Call `useFetchStub()` inside a `describe` block to wire up
 * beforeEach/afterEach and get back inspection utilities.
 */

import { afterEach, beforeEach } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bracket, map } from "#fp";

// deno-lint-ignore no-explicit-any
type StubRef = { current: any };

export const useFetchStub = () => {
  const ref: StubRef = { current: null };
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    ref.current = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response()),
    );
  });

  afterEach(() => {
    ref.current.restore();
    globalThis.fetch = originalFetch;
  });

  const restubFetch = (impl: () => Promise<Response>): void => {
    ref.current.restore();
    ref.current = stub(globalThis, "fetch", impl);
  };

  const callCount = (): number => ref.current.calls.length;

  const getFetchArgs = (index = 0): [string, RequestInit] =>
    ref.current.calls[index].args as [string, RequestInit];

  const getFetchJsonBody = (index = 0) =>
    JSON.parse(getFetchArgs(index)[1].body as string);

  const getFetchFormBody = (index = 0): FormData =>
    getFetchArgs(index)[1].body as FormData;

  const getFetchHeaders = (index = 0): Record<string, string> =>
    getFetchArgs(index)[1].headers as Record<string, string>;

  const findCallBodyByRecipient = (recipient: string) => {
    const call = ref.current.calls.find((c: { args: unknown[] }) => {
      const body = JSON.parse(
        (c.args as [string, RequestInit])[1].body as string,
      );
      return body.to[0] === recipient;
    });
    return JSON.parse((call.args as [string, RequestInit])[1].body as string);
  };

  const allRecipients = (): string[][] =>
    ref.current.calls.map(
      (c: { args: unknown[] }) =>
        JSON.parse((c.args as [string, RequestInit])[1].body as string).to,
    );

  return {
    restubFetch,
    callCount,
    getFetchArgs,
    getFetchJsonBody,
    getFetchFormBody,
    getFetchHeaders,
    findCallBodyByRecipient,
    allRecipients,
  };
};

/** Bracket around a console.error spy — acquires spy, runs callback, restores */
export const withErrorSpy = bracket(
  () =>
    // deno-lint-ignore no-explicit-any
    (stub as any)(console, "error") as {
      restore: () => void;
      calls: { args: unknown[] }[];
    },
  (s: { restore: () => void }) => s.restore(),
);

/** Extract string log messages from a console error spy */
export const collectErrorLogs = (errorSpy: {
  calls: { args: unknown[] }[];
}): string[] =>
  map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);

/** Assert that error logs contain E_EMAIL_SEND with a specific substring */
export const expectEmailSendLog = (
  logs: string[],
  substring: string,
): void => {
  const found = logs.some(
    (l) => l.includes("E_EMAIL_SEND") && l.includes(substring),
  );
  if (!found) {
    throw new Error(
      `Expected E_EMAIL_SEND log containing "${substring}" but got: ${JSON.stringify(logs)}`,
    );
  }
};
