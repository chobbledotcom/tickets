const checkout = {
  amount_total: 1000,
  created: 123,
  id: "cs_1",
  metadata: {},
  payment_intent: "pi_1",
  payment_status: "paid",
  url: "https://checkout.stripe.com/c/pay/cs_1",
};

/** Return valid Stripe fixtures for every operation used by the application. */
export const stripeResponseFor = (path: string, method: string): Response => {
  if (path === "/v1/balance") return Response.json({ livemode: false });
  if (path === "/v1/refunds") {
    return Response.json({ id: "re_1", status: "succeeded" });
  }
  if (path.startsWith("/v1/payment_intents/")) {
    return Response.json({
      id: "pi_1",
      latest_charge: { refunded: false },
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
      has_more: false,
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
