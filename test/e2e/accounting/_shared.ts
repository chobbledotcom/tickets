import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { legsOfKind } from "./ledger-helpers.ts";

/** The legs of one kind posted to an attendee's own ledger account — e.g. the
 *  `refund_cash` legs (the money handed back) on their account. */
export const attendeeLegsOfKind = async (
  attendeeId: number,
  kind: string,
): Promise<Transfer[]> =>
  legsOfKind(await transfersByAccount(attendeeAccount(attendeeId)), kind);
