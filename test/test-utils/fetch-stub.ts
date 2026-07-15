import { type Stub, stub } from "@std/testing/mock";

export type FetchResponder = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

export type FetchReply = Error | FetchResponder | Response;

/**
 * Stub fetch for the current `using` scope. One reply repeats; two or more are
 * used in order. An Error rejects the request, while a responder can inspect it.
 */
export const stubFetch = (
  first: FetchReply,
  ...following: FetchReply[]
): Stub => {
  const replies = [first, ...following];
  const state = { next: 0 };
  return stub(globalThis, "fetch", (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const index = following.length === 0 ? 0 : state.next++;
    const reply = replies[index];
    if (!reply) throw new Error(`No fetch reply queued for call ${index + 1}`);
    if (reply instanceof Error) throw reply;
    if (typeof reply !== "function") return reply;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return await reply(url, init);
  }) as typeof globalThis.fetch);
};
