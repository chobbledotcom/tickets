/**
 * Ends a Square payment link, and reads Square's delete answer into the one
 * event that answer proves.
 *
 * Only `cancelled_order_id` proves the order went CANCELED. Square has
 * answered 200 without it while the link stayed payable and was later paid,
 * so that shape is a failure, not a success. A 404 proves the link is already
 * gone. A refusal that names a paid or completed order ends the row too,
 * because the webhook and the return path own completion. Every other answer
 * proves nothing, and the row waits out the failure retry.
 */

import type { SquareLinkEndEventId } from "#payment/square-link-end-machine-spec.ts";
import type { FetchResult } from "#shared/fetch.ts";
import type { GetSquareClient } from "#shared/square/client.ts";

/** Ask Square to end one payment link. The answer is the whole HTTP result,
 * because the classifier reads the status and the refusal words itself. The
 * task runs only where Square is configured, so a missing client is raised,
 * not worked around. */
export const endSquareLink = async (
  getClient: GetSquareClient,
  linkId: string,
): Promise<FetchResult> => {
  const client = await getClient();
  if (!client) {
    throw new Error("Square is not configured, so no link can be ended");
  }
  return client.checkout.paymentLinks.cancel({ linkId });
};

/** Read a delete answer body as JSON, or null when it carries none. A body
 * we cannot read proves nothing either way, so the row retries rather than
 * guessing. */
const jsonOrNull = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The order Square proved it canceled, or null when the answer names none. */
const cancelledOrderIdOf = (body: Record<string, unknown>): string | null => {
  const id: unknown = body.cancelled_order_id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/** Whether a refusal names a paid or completed order. Square words its
 * refusal in the error `code` and `detail`; the sandbox e2e leg pins the
 * exact shape, so this reads the state words themselves. */
const refusalNamesPaidOrder = (
  errors: readonly Record<string, unknown>[],
): boolean =>
  errors.some((entry) =>
    [entry.code, entry.detail].some(
      (word) =>
        typeof word === "string" &&
        (word.includes("PAID") || word.includes("COMPLETED")),
    ),
  );

/** The one event Square's delete answer proves. */
export const squareLinkEndEventOf = (
  answer: FetchResult,
): SquareLinkEndEventId => {
  if (answer.status === 404) return "delete_answered_missing";
  const body = jsonOrNull(answer.text);
  if (answer.ok) {
    return body !== null && cancelledOrderIdOf(body) !== null
      ? "delete_answered_cancelled"
      : "delete_inconclusive";
  }
  const errors =
    body !== null && Array.isArray(body.errors)
      ? (body.errors as readonly Record<string, unknown>[])
      : [];
  return refusalNamesPaidOrder(errors)
    ? "delete_refused_paid"
    : "delete_inconclusive";
};
