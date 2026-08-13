/* jscpd:ignore-start */
import * as v from "valibot";
import { malformedProviderRead } from "#shared/payment/provider-failures.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import { ResourceIdSchema } from "#shared/payment/resource-id.ts";
import type { GetSquareClient } from "#shared/square/client.ts";
import { squareReadFailure } from "#shared/square/outcomes.ts";
/* jscpd:ignore-end */

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

const SquareOrderMoneySchema = v.object({
  amount: v.optional(v.nullable(v.bigint())),
  currency: v.optional(v.nullable(v.string())),
});

const SquareOrderSchema = v.object({
  createdAt: v.optional(v.string()),
  id: ResourceIdSchema,
  metadata: v.optional(v.record(v.string(), v.string())),
  state: v.optional(v.string()),
  tenders: v.optional(
    v.array(
      v.object({
        id: v.optional(v.string()),
        paymentId: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
  totalMoney: v.optional(SquareOrderMoneySchema),
});

/** Read and normalize one Square order without confusing absence and failure. */
export const readSquareOrder = async (
  getClient: GetSquareClient,
  orderId: string,
): Promise<ProviderRead<SquareOrder>> => {
  const client = await getClient();
  if (!client) return { reason: "not_configured", status: "unavailable" };
  try {
    const { order } = await client.orders.get({ orderId });
    if (!order) {
      return { reason: "missing_documented_resource", status: "invalid" };
    }
    const parsed = v.safeParse(SquareOrderSchema, order);
    if (!parsed.success) return malformedProviderRead();
    if (parsed.output.id !== orderId) {
      return { reason: "mismatched_id", status: "invalid" };
    }
    return {
      resource: {
        createdAt: parsed.output.createdAt,
        id: parsed.output.id,
        metadata: parsed.output.metadata,
        state: parsed.output.state,
        tenders: parsed.output.tenders?.map((tender) => ({
          id: tender.id,
          paymentId: tender.paymentId ?? undefined,
        })),
        totalMoney: {
          amount: parsed.output.totalMoney?.amount ?? null,
          currency: parsed.output.totalMoney?.currency ?? null,
        },
      },
      status: "found",
    };
  } catch (error) {
    const failure = squareReadFailure(error);
    if (failure) return failure;
    throw error;
  }
};
