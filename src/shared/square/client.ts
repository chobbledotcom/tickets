/* jscpd:ignore-start */
import { settings } from "#db/settings.ts";
import { cachedClientFactory } from "#shared/payment-helpers.ts";
import { squareFetch } from "#shared/square/transport.ts";
import { type SquareMoney, squareAnswer } from "#shared/square/wire.ts";

/* jscpd:ignore-end */

/** One line sent to Square's payment-link endpoint. */
type SquareLineItem = {
  name: string;
  quantity: string;
  note: string;
  basePriceMoney: { amount: bigint; currency: string };
};

/** Input to Square's refund transport. */
export type RefundPaymentInput = {
  idempotencyKey: string;
  paymentId: string;
  amountMoney: SquareMoney;
};

/** Input accepted by the payment-link endpoint. */
export type CreatePaymentLinkInput = {
  idempotencyKey: string;
  order: {
    locationId: string;
    lineItems: SquareLineItem[];
    metadata: Record<string, string>;
  };
  checkoutOptions: { redirectUrl: string };
  prePopulatedData: {
    buyerEmail: string;
    buyerPhoneNumber?: string;
  };
};

const SQUARE_BASE_URL = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

/** Build the small REST client for the endpoints this application uses. Each
 * method asks Square once and reads that answer once, so nothing below this
 * line holds a Square value that {@link squareAnswer} has not checked. */
const createSquareClient = (accessToken: string, sandbox: boolean) => {
  const base = sandbox ? SQUARE_BASE_URL.sandbox : SQUARE_BASE_URL.production;
  const post = (path: string, body: unknown) =>
    squareFetch(accessToken, base, path, { body, method: "POST" });
  const get = (path: string) => squareFetch(accessToken, base, path);

  return {
    checkout: {
      paymentLinks: {
        create: async (input: CreatePaymentLinkInput) =>
          squareAnswer.paymentLink(
            await post("/v2/online-checkout/payment-links", {
              checkout_options: {
                redirect_url: input.checkoutOptions.redirectUrl,
              },
              idempotency_key: input.idempotencyKey,
              order: {
                line_items: input.order.lineItems.map((item) => ({
                  base_price_money: {
                    amount: item.basePriceMoney.amount,
                    currency: item.basePriceMoney.currency,
                  },
                  name: item.name,
                  note: item.note,
                  quantity: item.quantity,
                })),
                location_id: input.order.locationId,
                metadata: input.order.metadata,
              },
              pre_populated_data: {
                buyer_email: input.prePopulatedData.buyerEmail,
                buyer_phone_number: input.prePopulatedData.buyerPhoneNumber,
              },
            }),
          ),
      },
    },
    locations: {
      list: async () => squareAnswer.locations(await get("/v2/locations")),
    },
    orders: {
      get: async (input: { orderId: string }) =>
        squareAnswer.order(
          await get(`/v2/orders/${encodeURIComponent(input.orderId)}`),
        ),
    },
    payments: {
      get: async (input: { paymentId: string }) =>
        squareAnswer.payment(
          await get(`/v2/payments/${encodeURIComponent(input.paymentId)}`),
        ),
    },
    refunds: {
      refundPayment: async (input: RefundPaymentInput) =>
        squareAnswer.refund(
          await post("/v2/refunds", {
            amount_money: {
              amount: input.amountMoney.amount,
              currency: input.amountMoney.currency,
            },
            idempotency_key: input.idempotencyKey,
            payment_id: input.paymentId,
          }),
        ),
    },
  };
};

/** The REST methods available to Square domain operations. */
export type SquareClient = ReturnType<typeof createSquareClient>;
export type GetSquareClient = () => Promise<SquareClient | null>;

type SquareClientConfig = { accessToken: string; sandbox: boolean };

const clientCache = cachedClientFactory({
  create: ({ accessToken, sandbox }: SquareClientConfig) =>
    createSquareClient(accessToken, sandbox),
  createMessage: ({ sandbox }) =>
    `Creating new Square client (${sandbox ? "sandbox" : "production"})`,
  getConfig: () => {
    const accessToken = settings.square.accessToken;
    if (!accessToken) return null;
    return { accessToken, sandbox: settings.square.sandbox };
  },
  isSameConfig: (a, b) =>
    a.accessToken === b.accessToken && a.sandbox === b.sandbox,
  missingMessage: "No access token configured, cannot create client",
  provider: "Square",
});

/** Get the client for the current stored Square settings. */
export const getSquareClient = (): Promise<SquareClient | null> =>
  clientCache.getClient();

/** Clear the cached client after settings or test state changes. */
export const resetSquareClient = (): void => clientCache.reset();
