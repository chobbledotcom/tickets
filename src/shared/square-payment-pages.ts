import type { SquareResourceRead } from "#shared/square.ts";
import type {
  SquarePaymentListInput,
  SquarePaymentPage,
} from "#shared/square-client.ts";
import type { SquarePayment } from "#shared/square-payments.ts";

export const SQUARE_PAYMENT_PAGE_LIMIT = 8;

export type SquarePaymentPages =
  | { payments: Map<string, SquarePayment> }
  | { issue: "invalid" | "unavailable" };

type LoadSquarePaymentPage = (
  input: SquarePaymentListInput,
) => Promise<SquareResourceRead<SquarePaymentPage>>;

/** Load only requested payment ids across bounded Square list pages. */
export const readSquarePaymentPages = async (
  locationId: string,
  remaining: Set<string>,
  load: LoadSquarePaymentPage,
  found = new Map<string, SquarePayment>(),
  seenCursors = new Set<string>(),
  cursor?: string,
  page = 0,
): Promise<SquarePaymentPages> => {
  if (remaining.size === 0) return { payments: found };
  if (page === SQUARE_PAYMENT_PAGE_LIMIT) return { issue: "unavailable" };
  const result = await load({
    ...(cursor === undefined ? {} : { cursor }),
    locationId,
  });
  if (result.status !== "found") {
    return {
      issue: result.status === "unavailable" ? "unavailable" : "invalid",
    };
  }
  for (const payment of result.value.payments) {
    if (payment.id !== undefined && remaining.delete(payment.id)) {
      found.set(payment.id, payment);
    }
  }
  const nextCursor = result.value.cursor;
  if (nextCursor === undefined) return { payments: found };
  if (seenCursors.has(nextCursor)) return { issue: "invalid" };
  seenCursors.add(nextCursor);
  return readSquarePaymentPages(
    locationId,
    remaining,
    load,
    found,
    seenCursors,
    nextCursor,
    page + 1,
  );
};
