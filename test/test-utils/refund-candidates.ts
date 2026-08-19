import { assert } from "@std/assert";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import {
  getRefundCandidates,
  type RefundCandidate,
} from "#routes/admin/refunds/candidates.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** Refund candidates for fixtures that deliberately contain only current
 * indexed history. A legacy row means the fixture itself is incomplete. */
export const getCompleteRefundCandidates = async (
  attendees: Parameters<typeof getRefundCandidates>[0],
  privateKey: CryptoKey,
): Promise<RefundCandidate[]> => {
  const loaded = await getRefundCandidates(attendees, privateKey);
  const problem = {
    complete: "Test refund candidates are complete",
    legacy_unindexed:
      "Test refund candidates contain unindexed payment history",
    provider_unknown:
      "Test refund candidates contain a payment with no recorded provider",
    too_many_references: "Test refund candidates contain too many payment rows",
  } satisfies Record<typeof loaded.kind, string>;
  assert(loaded.kind === "complete", problem[loaded.kind]);
  return loaded.candidates;
};

/** Load and decrypt one listing before applying the production candidate
 * contract. Raw attendee rows do not carry usable PII fields. */
export const getCompleteRefundCandidatesForListing = async (
  listingId: number,
): Promise<RefundCandidate[]> => {
  const privateKey = await getTestPrivateKey();
  return getCompleteRefundCandidates(
    await decryptAttendees(await getAttendeesRaw(listingId), privateKey),
    privateKey,
  );
};
