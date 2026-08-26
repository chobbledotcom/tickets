import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ProviderTransportError } from "#payment/transport-error.ts";
import type { FetchReply } from "#test-utils/fetch-stub.ts";
import { stubJitter, withStripeWire } from "./fixtures.ts";

/** Read the balance behind one first answer: what came back, how many
 *  requests it took, and what the retry ladder waited. */
const balanceAfter = (
  firstAnswer: FetchReply,
): Promise<{ outcome: unknown; sent: number; waits: number[] }> =>
  withStripeWire(
    [firstAnswer, () => Response.json({ livemode: false })],
    async (client, wire) => {
      const outcome = await client.balance.retrieve().catch((error) => error);
      return { outcome, sent: wire.sent.length, waits: wire.waits() };
    },
  );

const expectLockTimeoutRetry = async (
  error: Record<string, string>,
): Promise<void> => {
  const { outcome, waits } = await balanceAfter(
    Response.json({ error: { ...error, message: "Locked" } }, { status: 429 }),
  );

  expect(outcome).toEqual({ livemode: false });
  expect(waits).toEqual([500]);
};

const expectNoRetry = async (firstAnswer: FetchReply): Promise<void> => {
  const { outcome, sent, waits } = await balanceAfter(firstAnswer);

  expect(outcome).toBeInstanceOf(ProviderTransportError);
  expect(sent).toBe(1);
  expect(waits).toEqual([]);
};

const expectRetryWaits = async (
  firstAnswer: FetchReply,
  expected: number[],
): Promise<void> => {
  const { outcome, waits } = await balanceAfter(firstAnswer);

  expect(outcome).toEqual({ livemode: false });
  expect(waits).toEqual(expected);
};

describe("Stripe response retries", () => {
  test("does not retry when Stripe forbids it", async () => {
    await expectNoRetry(
      Response.json(
        { error: { message: "No", type: "api_error" } },
        { headers: { "stripe-should-retry": "false" }, status: 500 },
      ),
    );
  });

  test("uses Retry-After when Stripe requests a retry", async () => {
    await expectRetryWaits(
      new Response("busy", {
        headers: { "retry-after": "2", "stripe-should-retry": "true" },
        status: 400,
      }),
      [2000],
    );
  });

  test("ignores an excessive Retry-After", async () => {
    await expectRetryWaits(
      new Response("busy", { headers: { "retry-after": "61" }, status: 500 }),
      [500],
    );
  });

  test("accepts Retry-After at the 60 second boundary", async () => {
    await expectRetryWaits(
      new Response("busy", { headers: { "retry-after": "60" }, status: 500 }),
      [60_000],
    );
  });

  test("uses the default delay for unusable Retry-After values", async () => {
    for (const retryAfter of ["1.5", "invalid", "0", "-1"]) {
      await expectRetryWaits(
        new Response("busy", {
          headers: { "retry-after": retryAfter },
          status: 500,
        }),
        [500],
      );
    }
  });

  test("does not retry a default non-retry response with Retry-After", async () => {
    for (const status of [400, 499]) {
      await expectNoRetry(
        Response.json(
          { error: { message: "No", type: "invalid_request_error" } },
          { headers: { "retry-after": "2" }, status },
        ),
      );
    }
  });

  test("caps exponential retry delays", async () => {
    using _jitter = stubJitter(0.5);
    let calls = 0;

    const waits = await withStripeWire(
      [
        () => {
          calls += 1;
          return calls <= 7
            ? new Response("busy", { status: 500 })
            : Response.json({ livemode: false });
        },
      ],
      async (client, wire) => {
        await client.balance.retrieve();
        return wire.waits();
      },
      { maxNetworkRetries: 7 },
    );

    expect(waits).toEqual([500, 500, 750, 1500, 3000, 5000, 5000]);
  });

  test("retries conflicts", async () => {
    await expectRetryWaits(new Response("conflict", { status: 409 }), [500]);
  });

  test("retries a 429 whose error code is lock_timeout", async () => {
    await expectLockTimeoutRetry({
      code: "lock_timeout",
      type: "invalid_request_error",
    });
  });

  test("retries a 429 whose error type is lock_timeout", async () => {
    await expectLockTimeoutRetry({ type: "lock_timeout" });
  });

  test("does not retry a 429 rate-limit without lock_timeout", async () => {
    await expectNoRetry(
      Response.json(
        {
          error: {
            code: "rate_limit",
            message: "Slow down",
            type: "rate_limit_error",
          },
        },
        { status: 429 },
      ),
    );
  });

  test("does not retry a 429 whose body cannot be parsed as JSON", async () => {
    await expectNoRetry(new Response("not json", { status: 429 }));
  });
});
