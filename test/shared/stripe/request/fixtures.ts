import { type Stub, stub } from "@std/testing/mock";
import {
  createStripeClient,
  type StripeClient,
} from "#shared/stripe/client.ts";
import type { StripeClientConfig } from "#shared/stripe/request.ts";
import {
  type FetchReply,
  type FetchResponder,
  stubFetch,
} from "#test-utils/fetch-stub.ts";
import { stripeRefund } from "#test-utils/stripe/fixtures.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

/** The key every wired client authenticates with. */
export const WIRE_SECRET_KEY = "sk_test_secret";

/** A response whose body stream fails with the supplied transport error. */
export const unreadableResponse = (error: unknown, status = 200): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    { status },
  );

/** One request that reached the wire, and the moment it was sent. */
export type SentRequest = {
  readonly at: number;
  readonly init: RequestInit;
  readonly url: string;
};

/** Every Stripe request one test made. */
export type StripeWire = {
  readonly sent: SentRequest[];
  /** The Idempotency-Key header each request carried. */
  keys: () => (string | null)[];
  /** The gap before each attempt after the first, on the virtual clock: what
   *  the retry ladder actually waited. */
  waits: () => number[];
};

const recorded =
  (sent: SentRequest[]) =>
  (answer: FetchReply): FetchResponder =>
  async (url, init) => {
    sent.push({ at: Date.now(), init: init ?? {}, url });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? await answer(url, init) : answer;
  };

/**
 * Ask Stripe over a stubbed wire. One answer repeats; several are used in
 * order. The backoff waits run on a virtual clock, so a test that drives the
 * retry ladder finishes instantly and can still read the exact waits.
 *
 * Pass a function as an answer whenever it is used more than once: a Response
 * body can only be read one time.
 */
export const withStripeWire = <T>(
  answers: readonly [FetchReply, ...FetchReply[]],
  run: (client: StripeClient, wire: StripeWire) => Promise<T>,
  config: StripeClientConfig = {},
): Promise<T> =>
  withVirtualBackoff(async () => {
    const sent: SentRequest[] = [];
    const record = recorded(sent);
    using _fetch = stubFetch(
      record(answers[0]),
      ...answers.slice(1).map(record),
    );
    return await run(createStripeClient(WIRE_SECRET_KEY, config), {
      keys: () =>
        sent.map(({ init }) =>
          new Headers(init.headers).get("idempotency-key"),
        ),
      sent,
      waits: () => sent.slice(1).map(({ at }, index) => at - sent[index]!.at),
    });
  });

/** Fix the jitter every backoff adds, so a test can pin the exact waits. */
export const stubJitter = (value: number): Stub =>
  stub(Math, "random", () => value);

/** The Idempotency-Key header a refund POST sends. The client allows one
 *  retry, so a retry-generated key would exist by default; a caller's own key
 *  must take precedence over it. */
export const refundKeySentWith = (
  idempotencyKey?: string,
): Promise<string | null> =>
  withStripeWire(
    [() => Response.json(stripeRefund())],
    async (client, wire) => {
      await client.refunds.create(
        { amount: 1000, payment_intent: "pi_1" },
        idempotencyKey,
      );
      return wire.keys()[0] ?? null;
    },
    { maxNetworkRetries: 1 },
  );
