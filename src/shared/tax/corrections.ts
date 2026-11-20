import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
  TAX_VAT,
  WRITEOFF,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { legReference } from "#accounting/refs.ts";
import { signedLegParts } from "#accounting/signed-leg.ts";
import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";
import { taxRevisionGroup } from "#shared/tax/store.ts";
import type { TaxAssessment } from "#shared/tax/types.ts";

/** Each delta changes the assessment, not cash or the original booking event.
 * A taxable charge posts to the write-off account, as its own leg did. Its
 * correction keeps the `adjustment` kind and names the charge by position. */
export const taxCorrectionLegs = async (
  attendeeId: number,
  bookingGroup: string,
  revision: number,
  before: TaxAssessment,
  after: TaxAssessment,
  occurredAt: string,
  postedBy: string,
): Promise<TransferInput[]> => {
  const attendee = attendeeAccount(attendeeId);
  const group = await taxRevisionGroup(bookingGroup, revision);
  const deltas: {
    account: AccountRef;
    delta: number;
    key: string;
    kind: string;
  }[] = [
    ...after.lines.map((line, index) => ({
      account: revenueAccount(line.listingId),
      delta: line.gross - before.lines[index]!.gross,
      key: String(line.listingId),
      kind: KIND.taxSale,
    })),
    ...after.charges.map((charge, index) => ({
      account: WRITEOFF,
      delta: charge.gross - before.charges[index]!.gross,
      key: `charge-${index}`,
      kind: KIND.adjustment,
    })),
    ...after.modifiers.map((modifier, index) => ({
      account: modifierAccount(modifier.modifierId),
      delta: modifier.delta - before.modifiers[index]!.delta,
      key: String(modifier.modifierId),
      kind: KIND.taxModifier,
    })),
    {
      account: TAX_VAT,
      delta: after.taxAmount - before.taxAmount,
      key: TAX_VAT.id,
      kind: KIND.vat,
    },
  ];
  return Promise.all(
    deltas
      .filter(({ delta }) => delta !== 0)
      .map(async ({ account, delta, key, kind }) => ({
        ...signedLegParts(account, attendee)(delta),
        eventGroup: group,
        kind,
        occurredAt,
        postedBy,
        reference: await legReference([
          "tax-assessment",
          bookingGroup,
          revision,
          kind,
          key,
        ]),
      })),
  );
};
