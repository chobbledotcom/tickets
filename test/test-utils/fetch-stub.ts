import { afterEach } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";

/**
 * Scoped `globalThis.fetch` stub — call inside a describe block. Tests that
 * exercise outbound HTTP (Botpoison, address lookup providers, …) install an
 * implementation per test via `stubFetch`; the stub is restored after each
 * test automatically.
 */
export const setupFetchStub = (): {
  stubFetch: (
    impl: (url: string, init?: RequestInit) => Promise<Response>,
  ) => void;
  callCount: () => number;
} => {
  let fetchStub: Stub | undefined;
  afterEach(() => {
    fetchStub?.restore();
    fetchStub = undefined;
  });
  return {
    // Callers always install a stub before reading the count.
    callCount: () => fetchStub!.calls.length,
    stubFetch: (impl) => {
      fetchStub = stub(
        globalThis,
        "fetch",
        impl as unknown as typeof globalThis.fetch,
      );
    },
  };
};
