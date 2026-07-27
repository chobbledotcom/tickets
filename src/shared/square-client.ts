/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { isNotNullish } from "#fp";
import { fetchText } from "#shared/fetch.ts";
import {
  CurrencySchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import {
  providerInstantSchema,
  StringMapSchema,
} from "#shared/provider-boundary.ts";
import type { SquareOrder, SquarePayment } from "#shared/square-payments.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { UrlSchema } from "#shared/validation/string.ts";

/* jscpd:ignore-end */

export const SQUARE_API_VERSION = "2025-01-23";

const SQUARE_BASE_URL = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export type SquareRequestOptions = { method?: string; body?: unknown };

const jsonStringify = (value: unknown): string =>
  JSON.stringify(value, (_, field) =>
    typeof field === "bigint" ? Number(field) : field,
  );

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

export class SquareHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Status code: ${status} Body: ${body}`);
    this.name = "SquareHttpError";
    this.status = status;
  }
}

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
  if (!response.ok) throw new SquareHttpError(response.status, response.text);
  return JSON.parse(response.text);
};

const TimestampSchema = providerInstantSchema("Square");
const SquareMinorUnitsSchema = integerAtLeast(0);
const SquareMoneySchema = v.object({
  amount: SquareMinorUnitsSchema,
  currency: CurrencySchema,
});
const SquareMetadataSchema = StringMapSchema;
const SquareRawTenderSchema = v.object({
  id: v.optional(ResourceIdSchema),
  payment_id: v.optional(v.nullable(ResourceIdSchema)),
  paymentId: v.optional(v.nullable(ResourceIdSchema)),
});
export const SquareOrderStatusSchema = v.picklist([
  "OPEN",
  "COMPLETED",
  "CANCELED",
  "DRAFT",
]);
const SquareOrderSchema = v.object({
  created_at: TimestampSchema,
  id: ResourceIdSchema,
  location_id: ResourceIdSchema,
  metadata: v.optional(v.nullable(SquareMetadataSchema)),
  state: SquareOrderStatusSchema,
  tenders: v.optional(v.array(SquareRawTenderSchema)),
  total_money: SquareMoneySchema,
});
const SquareOrderResponseSchema = v.object({ order: SquareOrderSchema });
export const SquarePaymentStatusSchema = v.picklist([
  "APPROVED",
  "PENDING",
  "COMPLETED",
  "CANCELED",
  "FAILED",
]);
const SquarePaymentSchema = v.object({
  amount_money: SquareMoneySchema,
  created_at: TimestampSchema,
  id: ResourceIdSchema,
  location_id: ResourceIdSchema,
  order_id: ResourceIdSchema,
  refunded_money: v.optional(SquareMoneySchema),
  status: SquarePaymentStatusSchema,
});
const SquarePaymentResponseSchema = v.object({ payment: SquarePaymentSchema });
const SquarePaymentsResponseSchema = v.object({
  cursor: v.optional(ResourceIdSchema),
  payments: v.optional(v.array(SquarePaymentSchema)),
});
const SquareRefundSchema = v.object({
  amount_money: SquareMoneySchema,
  id: ResourceIdSchema,
  payment_id: ResourceIdSchema,
  status: v.picklist(["PENDING", "COMPLETED", "REJECTED", "FAILED"]),
});
const SquareRefundResponseSchema = v.object({ refund: SquareRefundSchema });
const SquarePaymentLinkResponseSchema = v.object({
  payment_link: v.object({
    created_at: TimestampSchema,
    id: ResourceIdSchema,
    long_url: UrlSchema,
    order_id: ResourceIdSchema,
    url: UrlSchema,
  }),
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
  amountMoney: { amount: bigint; currency: string };
};

export type SquareRefund = {
  amount: { amount: number; currency: string };
  id: string;
  paymentId: string;
  status: "PENDING" | "COMPLETED" | "REJECTED" | "FAILED";
};

export type SquarePaymentPage = {
  cursor?: string | undefined;
  payments: SquarePayment[];
};

export type SquarePaymentListInput = {
  cursor?: string | undefined;
  locationId: string;
};

type SquareLocation = { id?: string; name?: string; status?: string };
type SquareLocationsResponse = { locations?: SquareLocation[] };

export interface SquareClient {
  checkout: {
    paymentLinks: {
      create(input: CreatePaymentLinkInput): Promise<{
        paymentLink: { orderId: string; url: string };
      }>;
    };
  };
  locations: { list(): Promise<SquareLocationsResponse> };
  orders: {
    get(input: { orderId: string }): Promise<{ order: SquareOrder }>;
  };
  payments: {
    get(input: { paymentId: string }): Promise<{ payment: SquarePayment }>;
    list(input: SquarePaymentListInput): Promise<SquarePaymentPage>;
  };
  refunds: {
    get(input: { refundId: string }): Promise<SquareRefund>;
    requestRefund(input: RefundPaymentInput): Promise<SquareRefund>;
  };
}

const mapOrder = (
  order: v.InferOutput<typeof SquareOrderSchema>,
): SquareOrder => ({
  createdAt: order.created_at,
  id: order.id,
  locationId: order.location_id,
  ...(order.metadata === null || order.metadata === undefined
    ? {}
    : { metadata: order.metadata }),
  state: order.state,
  tenders: order.tenders?.map((tender) => {
    const paymentId = tender.paymentId ?? tender.payment_id;
    return {
      ...(tender.id === undefined ? {} : { id: tender.id }),
      ...(paymentId === null || paymentId === undefined ? {} : { paymentId }),
    };
  }),
  totalMoney: {
    amount: BigInt(order.total_money.amount),
    currency: order.total_money.currency,
  },
});

const mapPayment = (
  payment: v.InferOutput<typeof SquarePaymentSchema>,
): SquarePayment => ({
  amountMoney: {
    amount: BigInt(payment.amount_money.amount),
    currency: payment.amount_money.currency,
  },
  createdAt: payment.created_at,
  id: payment.id,
  locationId: payment.location_id,
  orderId: payment.order_id,
  ...(payment.refunded_money === undefined
    ? {}
    : {
        refundedMoney: {
          amount: BigInt(payment.refunded_money.amount),
          currency: payment.refunded_money.currency,
        },
      }),
  status: payment.status,
});

const mapPaymentPage = (response: unknown): SquarePaymentPage => {
  const page = v.parse(SquarePaymentsResponseSchema, response);
  return {
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    payments: (page.payments ?? []).map(mapPayment),
  };
};

const mapRefund = (response: unknown): SquareRefund => {
  const refund = v.parse(SquareRefundResponseSchema, response).refund;
  return {
    amount: refund.amount_money,
    id: refund.id,
    paymentId: refund.payment_id,
    status: refund.status,
  };
};

export const createSquareClient = (
  accessToken: string,
  sandbox: boolean,
): SquareClient => {
  const base = sandbox ? SQUARE_BASE_URL.sandbox : SQUARE_BASE_URL.production;
  const post = (path: string, body: unknown): Promise<unknown> =>
    squareFetch(accessToken, base, path, { body, method: "POST" });
  const get = (path: string): Promise<unknown> =>
    squareFetch(accessToken, base, path);

  return {
    checkout: {
      paymentLinks: {
        create: async (input: CreatePaymentLinkInput) => {
          const response = v.parse(
            SquarePaymentLinkResponseSchema,
            await post("/v2/online-checkout/payment-links", {
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
                ...(input.prePopulatedData.buyerPhoneNumber === undefined
                  ? {}
                  : {
                      buyer_phone_number:
                        input.prePopulatedData.buyerPhoneNumber,
                    }),
              },
            }),
          );
          return {
            paymentLink: {
              orderId: response.payment_link.order_id,
              url: response.payment_link.long_url,
            },
          };
        },
      },
    },
    locations: {
      list: () => get("/v2/locations") as Promise<SquareLocationsResponse>,
    },
    orders: {
      get: async (input: { orderId: string }) => ({
        order: mapOrder(
          v.parse(
            SquareOrderResponseSchema,
            await get(`/v2/orders/${encodeURIComponent(input.orderId)}`),
          ).order,
        ),
      }),
    },
    payments: {
      get: async (input: { paymentId: string }) => ({
        payment: mapPayment(
          v.parse(
            SquarePaymentResponseSchema,
            await get(`/v2/payments/${encodeURIComponent(input.paymentId)}`),
          ).payment,
        ),
      }),
      list: async (input) => {
        const query = new URLSearchParams({
          limit: "100",
          location_id: input.locationId,
          sort_order: "ASC",
        });
        if (input.cursor !== undefined) query.set("cursor", input.cursor);
        return mapPaymentPage(await get(`/v2/payments?${query}`));
      },
    },
    refunds: {
      get: async (input: { refundId: string }) =>
        mapRefund(
          await get(`/v2/refunds/${encodeURIComponent(input.refundId)}`),
        ),
      requestRefund: async (input: RefundPaymentInput) =>
        mapRefund(
          await post("/v2/refunds", {
            amount_money: input.amountMoney,
            idempotency_key: input.idempotencyKey,
            payment_id: input.paymentId,
          }),
        ),
    },
  };
};
