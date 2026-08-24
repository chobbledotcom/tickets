/**
 * Every answer Square sends, and the one place each one is read.
 *
 * Square answers in snake_case, and this application holds its own shapes. A
 * resource is declared once here: the fields Square documents, and what we
 * make of them. Nothing below reads a field that the schema above it did not
 * check, so no Square answer becomes a claim instead of a fact.
 *
 * An answer that does not match is unusable, whatever came with it. Every
 * Square boundary reads that one failure the way it already reads a lost
 * connection or a refusal, so a broken answer needs no boundary of its own.
 */

import * as v from "valibot";
import { ResourceIdSchema } from "#payment/resource-id.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { optionalRecordList } from "#shared/validation/list.ts";
import { parseOrThrow } from "#shared/validation/parse.ts";
import {
  OptionalNullableStringSchema,
  OptionalStringSchema,
} from "#shared/validation/string.ts";

/** Text Square must fill in when it sends the field at all. */
const WireText = v.pipe(v.string(), v.minLength(1));

/** Square states money as whole minor units, so the amount is checked as a
 * whole number and held as a bigint. */
const WireMoney = v.object({
  amount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  currency: WireText,
});

type WireMoneyValue = v.InferOutput<typeof WireMoney>;

/** One money value in the minor units the payment boundary counts in. */
export type SquareMoney = { amount: bigint; currency: string };

const heldMoney = ({ amount, currency }: WireMoneyValue): SquareMoney => ({
  amount: BigInt(amount),
  currency,
});

const heldMoneyOrUndefined = (
  money: WireMoneyValue | undefined,
): SquareMoney | undefined => (money ? heldMoney(money) : undefined);

/** One Square payment, in the fields the money boundary judges it by. */
export type SquarePayment = {
  id: string;
  status: string;
  orderId?: string | undefined;
  amountMoney?: SquareMoney | undefined;
  refundedMoney?: SquareMoney | undefined;
};

const PaymentAnswer = v.pipe(
  v.object({
    payment: v.optional(
      v.object({
        amount_money: v.optional(WireMoney),
        id: ResourceIdSchema,
        order_id: v.optional(ResourceIdSchema),
        refunded_money: v.optional(WireMoney),
        status: WireText,
      }),
    ),
  }),
  v.transform(({ payment }): { payment: SquarePayment | null } =>
    payment
      ? {
          payment: {
            amountMoney: heldMoneyOrUndefined(payment.amount_money),
            id: payment.id,
            orderId: payment.order_id,
            refundedMoney: heldMoneyOrUndefined(payment.refunded_money),
            status: payment.status,
          },
        }
      : { payment: null },
  ),
);

/** The Square order facts used to rebuild a checkout session. */
export type SquareOrder = {
  id: string;
  metadata?: Record<string, string> | undefined;
  tenders?:
    | Array<{
        id?: string | undefined;
        paymentId?: string | undefined;
      }>
    | undefined;
  state?: string | undefined;
  totalMoney: { amount: bigint | null; currency: string | null };
  createdAt?: string | undefined;
};

/** An order nobody has paid yet carries no total, and that absence is the
 * answer. A total Square does send states both halves, like any other money. */
const heldOrderTotal = (
  money: WireMoneyValue | undefined,
): SquareOrder["totalMoney"] =>
  money ? heldMoney(money) : { amount: null, currency: null };

const OrderAnswer = v.pipe(
  v.object({
    order: v.optional(
      v.object({
        created_at: OptionalStringSchema,
        id: ResourceIdSchema,
        metadata: v.optional(v.record(v.string(), v.string())),
        state: OptionalStringSchema,
        tenders: optionalRecordList({
          id: OptionalStringSchema,
          payment_id: OptionalNullableStringSchema,
        }),
        total_money: v.optional(WireMoney),
      }),
    ),
  }),
  v.transform(({ order }): { order: SquareOrder | null } =>
    order
      ? {
          order: {
            createdAt: order.created_at,
            id: order.id,
            metadata: order.metadata,
            state: order.state,
            tenders: order.tenders?.map((tender) => ({
              id: tender.id,
              paymentId: tender.payment_id ?? undefined,
            })),
            totalMoney: heldOrderTotal(order.total_money),
          },
        }
      : { order: null },
  ),
);

/** A created Square order and the page its buyer pays on. */
export type SquarePaymentLink = { orderId: string; url: string };

/** Square sends a short and a long address for the same checkout page. The
 * long one carries the whole order, so it is the one the buyer is sent to. */
const PaymentLinkAnswer = v.pipe(
  v.object({
    payment_link: v.optional(
      v.object({
        long_url: v.optional(WireText),
        order_id: ResourceIdSchema,
        url: v.optional(WireText),
      }),
    ),
  }),
  v.transform(({ payment_link: link }) => ({
    orderId: link?.order_id,
    url: link?.long_url ?? link?.url,
  })),
  v.object({ orderId: ResourceIdSchema, url: WireText }),
);

/** One place a merchant takes money at. */
export type SquareLocation = {
  id?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
};

const LocationsAnswer = v.pipe(
  v.object({
    locations: optionalRecordList({
      id: OptionalStringSchema,
      name: OptionalStringSchema,
      status: OptionalStringSchema,
    }),
  }),
  v.transform(({ locations }): { locations: SquareLocation[] } => ({
    locations: locations ?? [],
  })),
);

/** One refund Square has named. Its status is Square's own word, because the
 * refund engine reads that word to decide whether the money moved. */
export type SquareRefund = {
  id: string;
  paymentId: string;
  status: "PENDING" | "COMPLETED" | "REJECTED" | "FAILED";
  amountMoney: SquareMoney;
};

const RefundAnswer = v.pipe(
  v.object({
    refund: v.object({
      amount_money: WireMoney,
      id: ResourceIdSchema,
      payment_id: ResourceIdSchema,
      status: v.picklist(["PENDING", "COMPLETED", "REJECTED", "FAILED"]),
    }),
  }),
  v.transform(({ refund }): { refund: SquareRefund } => ({
    refund: {
      amountMoney: heldMoney(refund.amount_money),
      id: refund.id,
      paymentId: refund.payment_id,
      status: refund.status,
    },
  })),
);

const readAnswer =
  <Output>(schema: v.BaseSchema<unknown, Output, v.BaseIssue<unknown>>) =>
  (body: unknown): Output =>
    parseOrThrow(schema, body, () =>
      transportError.unusable(providerDetail.square()),
    );

/** Read one Square answer as the resource it is meant to carry. */
export const squareAnswer = {
  locations: readAnswer(LocationsAnswer),
  order: readAnswer(OrderAnswer),
  payment: readAnswer(PaymentAnswer),
  paymentLink: readAnswer(PaymentLinkAnswer),
  refund: readAnswer(RefundAnswer),
};
