import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  type ProviderRetries,
  providerCaller,
  readProviderJson,
} from "#payment/provider-fetch.ts";
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-timeout.ts";
import {
  ProviderTransportError,
  providerDetail,
  rejectedBuyerFieldOf,
} from "#payment/transport-error.ts";
import type { FetchResult } from "#shared/fetch.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

const realFetch = globalThis.fetch;

type FetchCall = { args: [string, RequestInit] };

/** Answer every call with one response, and record what was asked. */
const answerWith = (answer: () => unknown): { calls: FetchCall[] } => {
  const mock = spy((_url: string, _init: RequestInit) => answer());
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock as unknown as { calls: FetchCall[] };
};

const ok = (body: string) => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(body),
});

const refusal = (status: number, body = "") => ({
  ok: false,
  status,
  text: () => Promise.resolve(body),
});

const sumup = providerCaller(() => providerDetail.sumup());

const thrownBy = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the provider boundary to throw");
};

const transportFrom = async (
  work: () => Promise<unknown>,
): Promise<ProviderTransportError> => {
  const error = await thrownBy(work);
  expect(error).toBeInstanceOf(ProviderTransportError);
  return error as ProviderTransportError;
};

describe("provider fetch boundary", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("hands back the answer body a provider sent", async () => {
    answerWith(() => Promise.resolve(ok("plain body")));
    expect(await sumup.text("https://api.example/x", { method: "GET" })).toBe(
      "plain body",
    );
  });

  test("reads a JSON answer into its value", async () => {
    answerWith(() => Promise.resolve(ok('{"id":"co_1"}')));
    expect(
      await sumup.json("https://api.example/x", { method: "GET" }),
    ).toEqual({ id: "co_1" });
  });

  test("sends the init it was given and the shared timeout", async () => {
    const calls = answerWith(() => Promise.resolve(ok("{}")));
    await sumup.json("https://api.example/x", {
      body: '{"a":1}',
      headers: { Authorization: "Bearer k" },
      method: "POST",
    });
    const init = calls.calls[0]!.args[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer k",
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("gives up on a silent provider after the shared timeout", async () => {
    using time = new FakeTime();
    const calls = answerWith(() => new Promise(() => {}));
    const read = sumup.json("https://api.example/x", {});
    read.catch(() => undefined);
    const { signal } = calls.calls[0]!.args[1];
    expect(signal?.aborted).toBe(false);
    await time.tickAsync(PROVIDER_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe("TimeoutError");
  });

  test("says a provider we could not reach was unreachable", async () => {
    answerWith(() => Promise.reject(new TypeError("connection reset")));
    const error = await transportFrom(() =>
      sumup.json("https://api.example/x", { method: "GET" }),
    );
    expect(error.facts).toEqual({ connectionReason: "network_error" });
  });

  test("says a provider that ran out of time timed out", async () => {
    answerWith(() =>
      Promise.reject(new DOMException("too slow", "TimeoutError")),
    );
    const error = await transportFrom(() =>
      sumup.json("https://api.example/x", { method: "GET" }),
    );
    expect(error.facts).toEqual({ connectionReason: "timeout" });
  });

  test("does not claim a failure that is not a failure to reach", async () => {
    const ours = new RangeError("a bug of ours");
    answerWith(() => Promise.reject(ours));
    expect(await thrownBy(() => sumup.json("https://api.example/x", {}))).toBe(
      ours,
    );
  });

  test("keeps the status a refusing provider answered with", async () => {
    answerWith(() => Promise.resolve(refusal(429)));
    const error = await transportFrom(() =>
      sumup.json("https://api.example/x", {}),
    );
    expect(error.facts).toEqual({ statusCode: 429 });
  });

  test("refuses before reading the body, so a broken error body keeps its status", async () => {
    answerWith(() => Promise.resolve(refusal(404, "not json at all")));
    const error = await transportFrom(() =>
      sumup.json("https://api.example/x", {}),
    );
    expect(error.facts).toEqual({ statusCode: 404 });
  });

  test("says an answer it cannot read is unusable", async () => {
    answerWith(() => Promise.resolve(ok("not json at all")));
    const error = await transportFrom(() =>
      sumup.json("https://api.example/x", {}),
    );
    expect(error.facts).toEqual({ malformed: true });
  });

  test("lets one provider read the field it rejected out of the answer body", async () => {
    const named = providerCaller((body) =>
      providerDetail.square(body.includes("buyer_email") ? "email" : null),
    );
    answerWith(() =>
      Promise.resolve(refusal(400, "pre_populated buyer_email")),
    );
    const error = await transportFrom(() =>
      named.json("https://api.example/x", {}),
    );
    expect(rejectedBuyerFieldOf(error)).toBe("email");
  });

  test("names a provider with no answer body at all when it cannot be reached", async () => {
    const named = providerCaller((body) =>
      providerDetail.square(body === "" ? null : "email"),
    );
    answerWith(() => Promise.reject(new TypeError("down")));
    const error = await transportFrom(() =>
      named.json("https://api.example/x", {}),
    );
    expect(rejectedBuyerFieldOf(error)).toBe(null);
  });

  test("does not read a rejected field out of an answer that succeeded", async () => {
    // Only a refusing answer names a rejected field. A 200 body we cannot read
    // is an unreadable answer, so nothing in it may be taken as a refusal.
    const named = providerCaller((body) =>
      providerDetail.square(body === "" ? null : "email"),
    );
    answerWith(() => Promise.resolve(ok("buyer_email but not json")));
    const error = await transportFrom(() =>
      named.json("https://api.example/x", {}),
    );
    expect(error.facts).toEqual({ malformed: true });
    expect(rejectedBuyerFieldOf(error)).toBe(null);
  });

  test("hands back a refused answer whole, so a provider can read it", async () => {
    answerWith(() => Promise.resolve(refusal(402, '{"code":"declined"}')));
    const answer = await sumup.answer("https://api.example/x", {});
    expect(answer.status).toBe(402);
    expect(answer.text).toBe('{"code":"declined"}');
  });

  test("asks once for a provider that declares no retries", async () => {
    const calls = answerWith(() => Promise.resolve(refusal(503)));
    await transportFrom(() => sumup.json("https://api.example/x", {}));
    expect(calls.calls).toHaveLength(1);
  });

  describe("asking again", () => {
    /** One provider that retries while `again` says so, waiting 100ms each
     *  time, and a record of every wait it was asked to make. */
    const askedTwice = (
      again: (answer: FetchResult) => boolean,
      limit = 1,
    ): {
      caller: ReturnType<typeof providerCaller>;
      waits: { retry: number; status: number | null }[];
    } => {
      const waits: { retry: number; status: number | null }[] = [];
      const retries: ProviderRetries = {
        again,
        limit,
        waitBefore: (retry, answer) => {
          waits.push({ retry, status: answer === null ? null : answer.status });
          return 100;
        },
      };
      return {
        caller: providerCaller(() => providerDetail.sumup(), retries),
        waits,
      };
    };

    test("asks again after the wait the provider declared", async () => {
      const { caller, waits } = askedTwice((answer) => answer.status === 503);
      let asked = 0;
      const calls = answerWith(() =>
        Promise.resolve(++asked === 1 ? refusal(503) : ok('{"id":"co_1"}')),
      );

      const read = await withVirtualBackoff(() =>
        caller.json("https://api.example/x", {}),
      );

      expect(read).toEqual({ id: "co_1" });
      expect(calls.calls).toHaveLength(2);
      expect(waits).toEqual([{ retry: 0, status: 503 }]);
    });

    test("takes the answer a provider does not want asked again", async () => {
      const { caller, waits } = askedTwice(() => false);
      const calls = answerWith(() => Promise.resolve(refusal(400)));

      const error = await transportFrom(() =>
        caller.json("https://api.example/x", {}),
      );

      expect(error.facts).toEqual({ statusCode: 400 });
      expect(calls.calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    test("gives up once the retry limit is spent", async () => {
      const { caller, waits } = askedTwice(() => true, 2);
      const calls = answerWith(() => Promise.resolve(refusal(503)));

      const error = await withVirtualBackoff(() =>
        transportFrom(() => caller.json("https://api.example/x", {})),
      );

      expect(error.facts).toEqual({ statusCode: 503 });
      expect(calls.calls).toHaveLength(3);
      expect(waits).toHaveLength(2);
    });

    test("asks again after a failure to reach the provider, without asking about an answer", async () => {
      let consulted = 0;
      const { caller, waits } = askedTwice(() => {
        consulted += 1;
        return false;
      });
      const calls = answerWith(() => Promise.reject(new TypeError("down")));

      const error = await withVirtualBackoff(() =>
        transportFrom(() => caller.json("https://api.example/x", {})),
      );

      expect(error.facts).toEqual({ connectionReason: "network_error" });
      expect(calls.calls).toHaveLength(2);
      expect(consulted).toBe(0);
      expect(waits).toEqual([{ retry: 0, status: null }]);
    });
  });

  test("reads a body already in hand as JSON", () => {
    expect(
      readProviderJson(providerDetail.sumup(), '{"kind":"refund"}'),
    ).toEqual({ kind: "refund" });
  });

  test("says a body already in hand is unusable when it is not JSON", () => {
    let thrown: unknown;
    try {
      readProviderJson(providerDetail.sumup(), "<html>nope</html>");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderTransportError);
    expect((thrown as ProviderTransportError).facts).toEqual({
      malformed: true,
    });
  });
});
