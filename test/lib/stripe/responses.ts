const checkout = {
  amount_total: 1000,
  created: 123,
  currency: "gbp",
  id: "cs_1",
  livemode: false,
  metadata: {},
  payment_intent: "pi_1",
  payment_status: "paid",
  status: "complete",
  url: "https://checkout.stripe.com/c/pay/cs_1",
};

const charge = {
  amount: 1000,
  amount_captured: 1000,
  amount_refunded: 0,
  captured: true,
  created: 125,
  currency: "gbp",
  id: "ch_1",
  livemode: false,
  paid: true,
  payment_intent: "pi_1",
  refunded: false,
};

const refund = {
  amount: 1000,
  charge: "ch_1",
  created: 126,
  currency: "gbp",
  id: "re_1",
  payment_intent: "pi_1",
  status: "succeeded",
};

/** Return valid Stripe fixtures for every operation used by the application. */
export const stripeResponseFor = (path: string, method: string): Response => {
  if (path === "/v1/account") return Response.json({ id: "acct_1" });
  if (path === "/v1/balance") return Response.json({ livemode: false });
  if (path === "/v1/refunds" || path.startsWith("/v1/refunds/")) {
    return Response.json(refund);
  }
  if (path.startsWith("/v1/payment_intents/")) {
    return Response.json({
      amount: 1000,
      amount_received: 1000,
      created: 124,
      currency: "gbp",
      id: "pi_1",
      latest_charge: charge,
      livemode: false,
      status: "succeeded",
    });
  }
  if (
    path === "/v1/checkout/sessions" ||
    path.startsWith("/v1/checkout/sessions/")
  ) {
    return Response.json(checkout);
  }
  if (path === "/v1/webhook_endpoints" && method === "GET") {
    return Response.json({
      data: [
        {
          enabled_events: ["checkout.session.completed"],
          id: "we_1",
          status: "enabled",
          url: "https://example.com/payment/webhook",
        },
      ],
    });
  }
  if (path.startsWith("/v1/webhook_endpoints") && method === "DELETE") {
    return Response.json({ deleted: true, id: "we_1" });
  }
  if (path.startsWith("/v1/webhook_endpoints")) {
    return Response.json({ id: "we_1", secret: "whsec_1" });
  }
  throw new Error(`Unexpected Stripe test request: ${method} ${path}`);
};
