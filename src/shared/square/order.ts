/* jscpd:ignore-start */
import * as v from "valibot";
import type { ProviderRead } from "#payment/provider-read.ts";
import { ResourceIdSchema } from "#payment/resource-id.ts";
import type { GetSquareClient } from "#shared/square/client.ts";
import { readSquareResource } from "#shared/square/read.ts";
import { OptionalNullableStringSchema } from "#shared/validation/string.ts";
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
  currency: OptionalNullableStringSchema,
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
        paymentId: OptionalNullableStringSchema,
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
  return readSquareResource(client, {
    matches: (order) => order.id === orderId,
    parse: (order) => {
      const parsed = v.safeParse(SquareOrderSchema, order);
      return parsed.success
        ? {
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
          }
        : null;
    },
    read: (square) => square.orders.get({ orderId }),
    resource: (response) => response.order,
  });
};
