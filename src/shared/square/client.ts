import * as v from "valibot";
import { isNotNullish } from "#fp";
import { fetchText } from "#shared/fetch.ts";
import {
  SquareOrderResponseSchema,
  SquarePaymentResponseSchema,
} from "#shared/square/schemas.ts";

export const SQUARE_API_VERSION = "2025-01-23";

const SQUARE_BASE_URL = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

const jsonStringify = (value: unknown): string =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? Number(item) : item,
  );

export type SquareRequestOptions = { method?: string; body?: unknown };

export const squareRequestInit = (
  token: string,
  options?: SquareRequestOptions,
): { headers: Record<string, string>; method: string; body?: string } => {
  const body = options?.body;
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
    },
    method: options?.method ?? "GET",
    ...(isNotNullish(body) ? { body: jsonStringify(body) } : {}),
  };
};

const squareFetch = async (
  token: string,
  baseUrl: string,
  path: string,
  options?: SquareRequestOptions,
): Promise<unknown> => {
  const response = await fetchText(
    `${baseUrl}${path}`,
    squareRequestInit(token, options),
  );
  if (!response.ok) {
    throw new Error(`Status code: ${response.status} Body: ${response.text}`);
  }
  return JSON.parse(response.text);
};

type SquareRawTender = {
  id?: string | undefined;
  payment_id?: string | undefined;
};

const mapTender = (tender: SquareRawTender) => ({
  id: tender.id,
  paymentId: tender.payment_id,
});

export type SquareLineItem = {
  name: string;
  quantity: string;
  note: string;
  basePriceMoney: { amount: bigint; currency: string };
};

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

export type RefundPaymentInput = {
  idempotencyKey: string;
  paymentId: string;
  amountMoney: { amount: bigint | undefined; currency: string };
};

type SquarePaymentLinkResponse = {
  payment_link?: { order_id?: string; url?: string; long_url?: string };
};

export type SquareLocation = {
  id?: string;
  name?: string;
  status?: string;
};

type SquareLocationsResponse = { locations?: SquareLocation[] };

export const createSquareClient = (accessToken: string, sandbox: boolean) => {
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
                  base_price_money: item.basePriceMoney,
                  name: item.name,
                  note: item.note,
                  quantity: item.quantity,
                })),
                location_id: input.order.locationId,
                metadata: input.order.metadata,
              },
              pre_populated_data: {
                buyer_email: input.prePopulatedData.buyerEmail,
                ...(input.prePopulatedData.buyerPhoneNumber
                  ? {
                      buyer_phone_number:
                        input.prePopulatedData.buyerPhoneNumber,
                    }
                  : {}),
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
      get: async ({ orderId }: { orderId: string }) => {
        const data = v.parse(
          SquareOrderResponseSchema,
          await squareFetch(
            accessToken,
            base,
            `/v2/orders/${encodeURIComponent(orderId)}`,
          ),
        );
        const order = data.order;
        if (!order) return { order: null };
        return {
          order: {
            createdAt: order.created_at,
            id: order.id,
            locationId: order.location_id,
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
      get: async ({ paymentId }: { paymentId: string }) => {
        const data = v.parse(
          SquarePaymentResponseSchema,
          await squareFetch(
            accessToken,
            base,
            `/v2/payments/${encodeURIComponent(paymentId)}`,
          ),
        );
        const payment = data.payment;
        if (!payment) return { payment: null };
        const money = (value: typeof payment.amount_money) =>
          value
            ? { amount: BigInt(value.amount), currency: value.currency }
            : undefined;
        return {
          payment: {
            amountMoney: money(payment.amount_money),
            id: payment.id,
            locationId: payment.location_id,
            orderId: payment.order_id,
            refundedMoney: money(payment.refunded_money),
            status: payment.status,
          },
        };
      },
    },
    refunds: {
      refundPayment: (input: RefundPaymentInput): Promise<unknown> =>
        post("/v2/refunds", {
          amount_money: input.amountMoney,
          idempotency_key: input.idempotencyKey,
          payment_id: input.paymentId,
        }),
    },
  };
};

export type SquareClient = ReturnType<typeof createSquareClient>;
