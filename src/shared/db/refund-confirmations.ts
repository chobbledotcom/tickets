import { sortStrings, unique } from "#fp";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { resultRows, type TxScope } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

export type RefundConfirmationWrite = {
  identity: string;
  kind: "current" | "new";
};

type RefundConfirmationInput = {
  attendeeId: number;
  referenceIndexes: readonly string[];
};

type RefundConfirmationRow = { identity: string };

const canonicalReferenceIndexes = (
  referenceIndexes: readonly string[],
): string[] => sortStrings(unique([...referenceIndexes]));

const confirmationIdentity = (
  attendeeId: number,
  referenceIndexes: readonly string[],
): Promise<string> => {
  const references = canonicalReferenceIndexes(referenceIndexes);
  if (references.length === 0 || references.some((index) => index === "")) {
    throw new Error("A refund confirmation needs indexed payment references");
  }
  return hmacHash(
    `refund-confirmation:1:${JSON.stringify([attendeeId, references])}`,
  );
};

/** Reserve the one confirmation for an attendee's exact returned charge set.
 * The unique identity turns sequential and concurrent replay into one write. */
export const insertRefundConfirmation = async (
  transaction: TxScope,
  input: RefundConfirmationInput,
): Promise<RefundConfirmationWrite> => {
  const identity = await confirmationIdentity(
    input.attendeeId,
    input.referenceIndexes,
  );
  const result = await transaction.execute({
    args: [identity, input.attendeeId, nowIso()],
    sql: `INSERT OR IGNORE INTO refund_confirmations
            (identity, attendee_id, created)
          VALUES (?, ?, ?)
          RETURNING identity`,
  });
  return {
    identity,
    kind:
      resultRows<RefundConfirmationRow>(result).length === 0
        ? "current"
        : "new",
  };
};
