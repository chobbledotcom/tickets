import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ProviderTransportError } from "#payment/transport-error.ts";
import type { FetchReply } from "#test-utils/fetch-stub.ts";
import { unreadableResponse, withStripeWire } from "./fixtures.ts";

/** What one balance read threw, with no retries allowed. */
const balanceErrorFrom = (answer: FetchReply): Promise<unknown> =>
  withStripeWire(
    [answer],
    (client) => client.balance.retrieve().catch((caught) => caught),
    {
      maxNetworkRetries: 0,
    },
  );

/** What one balance read threw, and what the retry ladder spent getting
 *  there. The answer repeats, so pass a function for anything read twice. */
const failingBalance = (
  answer: FetchReply,
  maxNetworkRetries: number,
): Promise<{ error: unknown; sent: number; waits: number[] }> =>
  withStripeWire(
    [answer],
    async (client, wire) => ({
      error: await client.balance.retrieve().catch((caught) => caught),
      sent: wire.sent.length,
      waits: wire.waits(),
    }),
    { maxNetworkRetries },
  );

const expectInternalErrorPropagates = async (
  message: string,
  answer: (internal: RangeError) => FetchReply,
): Promise<void> => {
  const internal = new RangeError(message);
  const { error, sent, waits } = await failingBalance(answer(internal), 2);

  expect(error).toBe(internal);
  expect(sent).toBe(1);
  expect(waits).toEqual([]);
};

describe("Stripe transport errors", () => {
  test("returns structured error fields from a non-ok response", async () => {
    const error = await balanceErrorFrom(
      Response.json(
        {
          error: {
            code: "resource_missing",
            message: "Private value",
            type: "invalid_request_error",
          },
        },
        { headers: { "request-id": "req_1" }, status: 404 },
      ),
    );

    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      detail: {
        code: "resource_missing",
        provider: "stripe",
        requestId: "req_1",
        type: "invalid_request_error",
      },
      facts: { statusCode: 404 },
      message: "Private value",
    });
    // Stripe's own wording rides on the message, where the sanitiser and the
    // checkout boundary already keep it from operators and buyers. None of
    // the closed fields may repeat it.
    expect(
      JSON.stringify((error as ProviderTransportError).detail),
    ).not.toContain("Private value");
  });

  test("fails loudly on invalid success JSON", async () => {
    const error = await balanceErrorFrom(new Response("not json"));

    expect((error as Error).message).toBe(
      "Invalid JSON received from the Stripe API",
    );
  });

  test("fails loudly on an invalid success shape", async () => {
    const error = await balanceErrorFrom(Response.json({ livemode: "no" }));

    expect((error as Error).message).toBe(
      "Invalid response received from the Stripe API",
    );
  });

  test("fails loudly on an invalid error response", async () => {
    const error = await balanceErrorFrom(
      new Response("not json", { status: 400 }),
    );

    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      facts: { malformed: true, statusCode: 400 },
      message: "Invalid JSON received from the Stripe API",
    });
  });

  test("reports valid JSON with a malformed error shape as a protocol error", async () => {
    const error = await balanceErrorFrom(
      Response.json({ error: {} }, { status: 400 }),
    );

    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      facts: { malformed: true, statusCode: 400 },
      message: "Invalid response received from the Stripe API",
    });
  });

  test("reports a connection failure after the configured retries", async () => {
    const { error, sent, waits } = await failingBalance(
      new TypeError("private network detail"),
      1,
    );

    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      facts: { connectionReason: "network_error" },
      message: "Stripe could not be reached",
    });
    expect(sent).toBe(2);
    expect(waits).toEqual([500]);
  });

  test("propagates an unexpected fetch implementation error", async () => {
    await expectInternalErrorPropagates(
      "broken request instrumentation",
      (internal) => internal,
    );
  });

  // Every provider aborts through `AbortSignal.timeout`, so an abort is a
  // timeout whatever name the runtime gives it. Stripe used to call a bare
  // abort a network failure while Square and SumUp called it a timeout.
  test("reports a transport abort as a timeout", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const { error, sent } = await failingBalance(
        new DOMException("stopped", name),
        0,
      );

      expect(error).toMatchObject({
        facts: { connectionReason: "timeout" },
        message: "Stripe did not answer in time",
        name: "ProviderTransportError",
      });
      expect(sent).toBe(1);
    }
  });

  test("retries a timeout while reading the response body", async () => {
    let calls = 0;
    const balance = await withStripeWire(
      [
        () => {
          calls += 1;
          return calls > 1
            ? Response.json({ livemode: false })
            : unreadableResponse(new DOMException("timed out", "TimeoutError"));
        },
      ],
      (client) => client.balance.retrieve(),
      { maxNetworkRetries: 1 },
    );

    expect(balance).toEqual({ livemode: false });
    expect(calls).toBe(2);
  });

  test("reports the exact connection failure after response body retries end", async () => {
    const { error, sent, waits } = await failingBalance(
      () => unreadableResponse(new TypeError("private body detail")),
      2,
    );

    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      facts: { connectionReason: "network_error" },
      message: "Stripe could not be reached",
    });
    expect(sent).toBe(3);
    expect(waits).toEqual([500, 500]);
  });

  test("propagates an unexpected response body implementation error", async () => {
    await expectInternalErrorPropagates(
      "broken response instrumentation",
      (internal) => () => unreadableResponse(internal),
    );
  });

  test("escapes resource IDs and encodes GET parameters", async () => {
    const sent = await withStripeWire(
      [
        Response.json({
          id: "pi_1",
          latest_charge: {
            amount_captured: 1000,
            amount_refunded: 0,
            captured: true,
            currency: "gbp",
            paid: true,
            status: "succeeded",
          },
        }),
      ],
      async (client, wire) => {
        await client.paymentIntents.retrieveWithLatestCharge("pi/unsafe");
        return wire.sent[0]!;
      },
      { maxNetworkRetries: 0 },
    );

    expect(sent.url).toBe(
      "https://api.stripe.com/v1/payment_intents/pi%2Funsafe?expand[0]=latest_charge",
    );
    expect(sent.init.body).toBeUndefined();
  });
});
