/* jscpd:ignore-start */
import { settings } from "#db/settings.ts";
import { cachedClientFactory } from "#shared/payment-helpers.ts";
import {
  parseSquarePaymentResponse,
  type RefundPaymentInput,
} from "#shared/square/payment-outcomes.ts";
import { squareFetch } from "#shared/square/transport.ts";

/* jscpd:ignore-end */

/** One line sent to Square's payment-link endpoint. */
type SquareLineItem = {
  name: string;
  quantity: string;
  note: string;
  basePriceMoney: { amount: bigint; currency: string };
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

type SquareRawTender = {
  id?: string | undefined;
  payment_id?: string | undefined;
  paymentId?: string | undefined;
};

const mapTender = (tender: SquareRawTender) => ({
  id: tender.id,
  paymentId: tender.paymentId ?? tender.payment_id,
});

type SquarePaymentLinkResponse = {
  payment_link?: {
    order_id?: string;
    url?: string;
    long_url?: string;
  };
};

type SquareOrderResponse = {
  order?: {
    id?: string;
    metadata?: Record<string, string | null>;
    tenders?: SquareRawTender[];
    state?: string;
    total_money?: { amount: number; currency: string };
    created_at?: string;
  };
};

export type SquareLocation = {
  id?: string;
  name?: string;
  status?: string;
};

type SquareLocationsResponse = {
  locations?: SquareLocation[];
};

const SQUARE_BASE_URL = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

/** Build the small REST client for the endpoints this application uses. */
const createSquareClient = (accessToken: string, sandbox: boolean) => {
  const base = sandbox ? SQUARE_BASE_URL.sandbox : SQUARE_BASE_URL.production;
  const post = <T>(path: string, body: unknown) =>
    squareFetch(accessToken, base, path, {
      body,
      method: "POST",
    }) as Promise<T>;
  const get = <T>(path: string) =>
    squareFetch(accessToken, base, path) as Promise<T>;

  return {
    checkout: {
      paymentLinks: {
        create: async (input: CreatePaymentLinkInput) => {
          const data = await post<SquarePaymentLinkResponse>(
            "/v2/online-checkout/payment-links",
            {
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
            },
          );
          const link = data.payment_link;
          return {
            paymentLink: link
              ? { orderId: link.order_id, url: link.long_url ?? link.url }
              : undefined,
          };
        },
      },
    },
    locations: {
      list: () => get<SquareLocationsResponse>("/v2/locations"),
    },
    orders: {
      get: async (input: { orderId: string }) => {
        const data = await get<SquareOrderResponse>(
          `/v2/orders/${encodeURIComponent(input.orderId)}`,
        );
        const order = data.order;
        if (!order) return { order: null };
        return {
          order: {
            createdAt: order.created_at,
            id: order.id,
            metadata: order.metadata,
            state: order.state,
            tenders: order.tenders?.map(mapTender),
            totalMoney: order.total_money
              ? {
                  amount: BigInt(order.total_money.amount),
                  currency: order.total_money.currency,
                }
              : undefined,
          },
        };
      },
    },
    payments: {
      get: async (input: { paymentId: string }) => {
        const raw = await get<unknown>(
          `/v2/payments/${encodeURIComponent(input.paymentId)}`,
        );
        return parseSquarePaymentResponse(raw);
      },
    },
    refunds: {
      refundPayment: async (input: RefundPaymentInput): Promise<unknown> =>
        await post<unknown>("/v2/refunds", {
          amount_money: {
            amount: input.amountMoney.amount,
            currency: input.amountMoney.currency,
          },
          idempotency_key: input.idempotencyKey,
          payment_id: input.paymentId,
        }),
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
