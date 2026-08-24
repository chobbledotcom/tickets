import { hmacHash } from "#crypto/hashing.ts";
import { resultRows, type TxScope } from "#db/client.ts";
import { sortStrings, unique } from "#fp";
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
  const referenceIndexes = canonicalReferenceIndexes(input.referenceIndexes);
  const identity = await confirmationIdentity(
    input.attendeeId,
    referenceIndexes,
  );
  const [confirmationResult] = await transaction.batch([
    {
      args: [identity, input.attendeeId, nowIso()],
      sql: `INSERT OR IGNORE INTO refund_confirmations
              (identity, attendee_id, created)
            VALUES (?, ?, ?)
            RETURNING identity`,
    },
    ...referenceIndexes.map((referenceIndex) => ({
      args: [identity, referenceIndex],
      sql: `INSERT OR IGNORE INTO refund_confirmation_references
              (confirmation_identity, reference_index)
            VALUES (?, ?)`,
    })),
  ]);
  if (confirmationResult === undefined) {
    throw new Error("Refund confirmation write returned no result");
  }
  return {
    identity,
    kind:
      resultRows<RefundConfirmationRow>(confirmationResult).length === 0
        ? "current"
        : "new",
  };
};
