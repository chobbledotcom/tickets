import type { FetchText, FetchTextResult } from "#scripts/fetch-text.ts";
import { answer } from "./fake-bunny.ts";

export type StripeCall = { auth: string | null; method: string; path: string };

export type FakeStripeOptions = {
  /** Answer `"METHOD /path"` with this status. */
  fails?: Record<string, number>;
  /** Endpoints per page. */
  pageSize?: number;
};

/** An in-memory Stripe account with webhook endpoints. */
export const fakeStripe = (
  urls: string[] = [],
  options: FakeStripeOptions = {},
) => {
  const calls: StripeCall[] = [];
  const endpoints = new Map(urls.map((url, index) => [`we_${index + 1}`, url]));
  const pageSize = options.pageSize ?? 100;

  const list = (query: URLSearchParams): FetchTextResult => {
    const ids = [...endpoints.keys()];
    const after = query.get("starting_after");
    const start = after === null ? 0 : ids.indexOf(after) + 1;
    const page = ids.slice(start, start + pageSize);
    return answer(200, {
      data: page.map((id) => ({ id, url: endpoints.get(id) })),
      has_more: start + pageSize < ids.length,
    });
  };

  const fetchText: FetchText = (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const method = String(init.method);
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ auth, method, path: pathname });
    const failure = options.fails?.[`${method} ${pathname}`];
    if (failure !== undefined) return Promise.resolve(answer(failure, "boom"));
    if (method === "GET") return Promise.resolve(list(searchParams));
    const id = pathname.split("/").pop() as string;
    endpoints.delete(id);
    return Promise.resolve(answer(200, { deleted: true, id }));
  };

  return { calls, endpoints, fetchText };
};

export type FakeStripe = ReturnType<typeof fakeStripe>;
