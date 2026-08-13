import {
  getRefundCandidates,
  type RefundCandidate,
} from "#routes/admin/refunds/candidates.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** Refund candidates for fixtures that deliberately contain only current
 * indexed history. A legacy row means the fixture itself is incomplete. */
export const getCompleteRefundCandidates = async (
  attendees: Parameters<typeof getRefundCandidates>[0],
  privateKey: CryptoKey,
): Promise<RefundCandidate[]> => {
  const loaded = await getRefundCandidates(attendees, privateKey);
  if (loaded.kind === "legacy_unindexed") {
    throw new Error("Test refund candidates contain unindexed payment history");
  }
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
