/**
 * A fake Stripe for black-box tests: an HTTP server that answers the calls the
 * app makes to Stripe, and keeps what the app sent.
 *
 * The app finds it through `STRIPE_MOCK_HOST` and `STRIPE_MOCK_PORT`, as it
 * finds stripe-mock. The fake hands out a webhook secret that the test knows,
 * so a test can send the callbacks that Stripe sends, signed the same way. A
 * test sees each checkout that the app opened, with the metadata that it sent.
 */

import { requireValue } from "#shared/required-value.ts";
import { withEnv } from "#test-utils/env.ts";

/** The webhook secret that the fake gives to the app. */
const WEBHOOK_SECRET = "whsec_blackbox";

/** One checkout that the app opened, as the fake keeps it. */
export interface FakeCheckout {
  amountTotal: number;
  id: string;
  metadata: Record<string, string>;
  paymentIntent: string;
}

/** One refund that the app asked for: the amount in minor units, and the
 * payment that it returns. */
export interface FakeRefund {
  amount: number;
  paymentIntent: string;
}

/** One call the fake answers: method, path, and the answer to give. The
 * path's first group, when it has one, is passed as `id`. */
type FakeRoute = readonly [
  method: string,
  path: RegExp,
  reply: (request: Request, id: string) => Response | Promise<Response>,
];

export interface FakeStripe {
  /** Every checkout that the app opened, oldest first. */
  readonly checkouts: FakeCheckout[];
  /** Stop the server and give the app back its environment. */
  close(): Promise<void>;
  /** A signed `checkout.session.completed` callback for a checkout. `charged`
   * is what Stripe says it took, and `metadata` replaces what the app sent. */
  completedEvent(
    checkout: FakeCheckout,
    changes?: { charged?: number; metadata?: Record<string, string> },
  ): Promise<{ body: string; signature: string }>;
  /** The buyer pays at Stripe. No callback is sent, so the app learns of the
   * payment only when it reads the checkout. */
  pay(checkout: FakeCheckout): void;
  /** Every refund that the app asked for, oldest first. */
  readonly refunds: FakeRefund[];
  /** Turn down every refund from now on, as Stripe does when it cannot pay
   * the money back. */
  refuseRefunds(): void;
}

/** Read the metadata fields of a form body: `metadata[name]=value`. */
const metadataOf = (form: URLSearchParams): Record<string, string> =>
  Object.fromEntries(
    [...form.entries()].flatMap(([key, value]) => {
      const name = key.match(/^metadata\[([^\]]+)\]$/)?.[1];
      return name === undefined ? [] : [[name, value]];
    }),
  );

/** The total of the line items of a form body, in minor units. */
const totalOf = (form: URLSearchParams): number => {
  let total = 0;
  for (let index = 0; form.has(`line_items[${index}][quantity]`); index++) {
    const unit = form.get(`line_items[${index}][price_data][unit_amount]`);
    total += Number(unit) * Number(form.get(`line_items[${index}][quantity]`));
  }
  return total;
};

/** A checkout session as Stripe returns it. */
const sessionJson = (
  checkout: FakeCheckout,
  paid: { charged: number; metadata: Record<string, string> } | null,
) => ({
  amount_total: paid?.charged ?? checkout.amountTotal,
  created: Math.floor(Date.now() / 1000),
  currency: "gbp",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  id: checkout.id,
  invoice: null,
  metadata: paid?.metadata ?? checkout.metadata,
  mode: "payment",
  object: "checkout.session",
  payment_intent: checkout.paymentIntent,
  payment_status: paid === null ? "unpaid" : "paid",
  status: paid === null ? "open" : "complete",
  subscription: null,
  url: `https://checkout.stripe.test/${checkout.id}`,
});

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The `stripe-signature` header for a body, as Stripe signs it. */
const signatureFor = async (body: string): Promise<string> => {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `t=${timestamp},v1=${hex(mac)}`;
};

/** Start a fake Stripe and point the app at it. */
export const startFakeStripe = async (): Promise<FakeStripe> => {
  const checkouts: FakeCheckout[] = [];
  const paidAs = new Map<string, number>();
  const refunds: FakeRefund[] = [];
  let refusing = false;

  const intentJson = (id: string) => {
    const captured = requireValue(
      paidAs.get(id),
      `Stripe took no payment for ${id}`,
    );
    return {
      id,
      latest_charge: {
        amount_captured: captured,
        amount_refunded: 0,
        captured: true,
        currency: "gbp",
        paid: true,
        status: "succeeded",
      },
      object: "payment_intent",
    };
  };

  const openCheckout = async (request: Request): Promise<Response> => {
    const form = new URLSearchParams(await request.text());
    const number = checkouts.length + 1;
    const checkout: FakeCheckout = {
      amountTotal: totalOf(form),
      id: `cs_blackbox_${number}`,
      metadata: metadataOf(form),
      paymentIntent: `pi_blackbox_${number}`,
    };
    checkouts.push(checkout);
    return Response.json(sessionJson(checkout, null));
  };

  const readCheckout = (id: string): Response => {
    const checkout = requireValue(
      checkouts.find((one) => one.id === id),
      `The fake opened no checkout ${id}`,
    );
    const charged = paidAs.get(checkout.paymentIntent);
    return Response.json(
      sessionJson(
        checkout,
        charged === undefined ? null : { charged, metadata: checkout.metadata },
      ),
    );
  };

  const refund = async (request: Request): Promise<Response> => {
    const form = new URLSearchParams(await request.text());
    const asked: FakeRefund = {
      amount: Number(form.get("amount")),
      paymentIntent: String(form.get("payment_intent")),
    };
    refunds.push(asked);
    if (refusing) {
      return Response.json(
        {
          error: {
            message: "The refund was refused.",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    }
    return Response.json({
      amount: asked.amount,
      currency: "gbp",
      id: `re_blackbox_${refunds.length}`,
      object: "refund",
      payment_intent: asked.paymentIntent,
      status: "succeeded",
    });
  };

  /** Each call the fake answers: its method, its path, and the answer. */
  const routes: readonly FakeRoute[] = [
    [
      "GET",
      /^\/v1\/webhook_endpoints$/,
      () => Response.json({ data: [], has_more: false }),
    ],
    [
      "POST",
      /^\/v1\/webhook_endpoints$/,
      () =>
        Response.json({
          enabled_events: ["checkout.session.completed"],
          id: "we_blackbox",
          secret: WEBHOOK_SECRET,
          status: "enabled",
        }),
    ],
    ["POST", /^\/v1\/checkout\/sessions$/, openCheckout],
    [
      "GET",
      /^\/v1\/checkout\/sessions\/([^/]+)$/,
      (_request, id) => readCheckout(id),
    ],
    [
      "GET",
      /^\/v1\/payment_intents\/([^/]+)$/,
      (_request, id) => Response.json(intentJson(id)),
    ],
    ["POST", /^\/v1\/refunds$/, refund],
  ];

  const answer = (request: Request): Response | Promise<Response> => {
    const { pathname } = new URL(request.url);
    const [route, id] = requireValue(
      routes.flatMap(([method, path, reply]) => {
        const match = request.method === method ? path.exec(pathname) : null;
        return match === null ? [] : [[reply, match[1] ?? ""] as const];
      })[0],
      `The fake has no answer for ${request.method} ${pathname}`,
    );
    return route(request, id);
  };

  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      onListen: ({ port }) => listening.resolve(port),
      port: 0,
    },
    answer,
  );
  const port = await listening.promise;
  const env = withEnv({
    STRIPE_MOCK_HOST: "127.0.0.1",
    STRIPE_MOCK_PORT: String(port),
  });

  return {
    checkouts,
    close: async () => {
      env[Symbol.dispose]();
      await server.shutdown();
    },
    completedEvent: async (checkout, changes = {}) => {
      const charged = changes.charged ?? checkout.amountTotal;
      paidAs.set(checkout.paymentIntent, charged);
      const body = JSON.stringify({
        data: {
          object: sessionJson(checkout, {
            charged,
            metadata: changes.metadata ?? checkout.metadata,
          }),
        },
        id: `evt_${checkout.id}_${charged}`,
        type: "checkout.session.completed",
      });
      return { body, signature: await signatureFor(body) };
    },
    pay: (checkout) => {
      paidAs.set(checkout.paymentIntent, checkout.amountTotal);
    },
    refunds,
    refuseRefunds: () => {
      refusing = true;
    },
  };
};
