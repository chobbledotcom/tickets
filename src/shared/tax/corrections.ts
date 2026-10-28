import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
  TAX_VAT,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { legReference } from "#accounting/refs.ts";
import { signedLegParts } from "#accounting/signed-leg.ts";
import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";
import { taxRevisionGroup } from "#shared/tax/store.ts";
import type { TaxAssessment } from "#shared/tax/types.ts";

/** Each delta changes the assessment, not cash or the original booking event. */
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
  const deltas: { account: AccountRef; delta: number; kind: string }[] = [
    ...after.lines.map((line, index) => ({
      account: revenueAccount(line.listingId),
      delta: line.gross - before.lines[index]!.gross,
      kind: KIND.taxSale,
    })),
    ...after.modifiers.map((modifier, index) => ({
      account: modifierAccount(modifier.modifierId),
      delta: modifier.delta - before.modifiers[index]!.delta,
      kind: KIND.taxModifier,
    })),
    {
      account: TAX_VAT,
      delta: after.taxAmount - before.taxAmount,
      kind: KIND.vat,
    },
  ];
  return Promise.all(
    deltas
      .filter(({ delta }) => delta !== 0)
      .map(async ({ account, delta, kind }) => ({
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
          account.id,
        ]),
      })),
  );
};
