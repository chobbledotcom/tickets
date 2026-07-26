import { spy } from "@std/testing/mock";

/** A recorded fetch call: the URL and the request init (method, headers, body). */
export type FetchCall = {
  args: [
    string,
    { method?: string; headers?: Record<string, string>; body?: string },
  ];
};

/** Build a mock Response with the body already available as text(). */
export const jsonResponse = (data: unknown) => ({
  ok: true,
  text: () => Promise.resolve(JSON.stringify(data)),
});

/** Create a mock fetch with the given implementation and assign to globalThis.
 * Returns the spy so the test can inspect the calls it recorded. */
export const installMockFetch = (
  impl: (...args: unknown[]) => unknown,
): { calls: FetchCall[] } => {
  const mockFetch = spy(impl) as unknown as { calls: FetchCall[] };
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  return mockFetch;
};
