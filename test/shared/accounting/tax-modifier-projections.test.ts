import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  modifierAccount,
  TAX_VAT,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { mapBooking, mapRefund } from "#accounting/mappers.ts";
import {
  externalCashBalanceSubquery,
  orderTotalSubquery,
  reservationSubtotalSubquery,
} from "#accounting/projection-sql.ts";
import { accountBalance, allTransfers } from "#accounting/queries.ts";
import { postTransfers } from "#accounting/store.ts";
import { queryOne } from "#db/client.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const customerTotals = () =>
  queryOne<{ cash: number; total: number; deposit_base: number }>(`SELECT
  ${externalCashBalanceSubquery("attendee", "1")} AS cash,
  ${orderTotalSubquery("attendee", "1")} AS total,
  ${reservationSubtotalSubquery("attendee", "1")} AS deposit_base`);

describe("db > accounting > tax modifier corrections", () => {
  useTransactionalDb();

  test("reclassifies option income in either direction without changing cash or the included-tax deposit", async () => {
    await postTransfers(
      await mapBooking({
        amountPaid: 1100,
        attendeeId: 1,
        bookingFee: 0,
        eventId: "modifier-tax",
        lines: [{ gross: 1000, listingId: 1 }],
        modifiers: [{ delta: 100, modifierId: 1 }],
        occurredAt: "2026-06-21T00:00:00.000Z",
      }),
    );
    await postTransfers([
      tx({
        amount: 20,
        destination: attendeeAccount(1),
        eventGroup: "tax-option-1",
        kind: KIND.taxModifier,
        reference: "option-less",
        source: modifierAccount(1),
      }),
      tx({
        amount: 20,
        destination: TAX_VAT,
        eventGroup: "tax-option-1",
        kind: KIND.vat,
        reference: "vat-more",
        source: attendeeAccount(1),
      }),
    ]);
    expect(await accountBalance(modifierAccount(1))).toBe(80);
    expect(await customerTotals()).toEqual({
      cash: 1100,
      deposit_base: 1100,
      total: 1100,
    });
    await postTransfers([
      tx({
        amount: 10,
        destination: modifierAccount(1),
        eventGroup: "tax-option-2",
        kind: KIND.taxModifier,
        reference: "option-more",
        source: attendeeAccount(1),
      }),
      tx({
        amount: 10,
        destination: attendeeAccount(1),
        eventGroup: "tax-option-2",
        kind: KIND.vat,
        reference: "vat-less",
        source: TAX_VAT,
      }),
    ]);
    expect(await accountBalance(modifierAccount(1))).toBe(90);
    expect(await customerTotals()).toEqual({
      cash: 1100,
      deposit_base: 1100,
      total: 1100,
    });
    for (const legs of Map.groupBy(
      await allTransfers(),
      (leg) => leg.eventGroup,
    ).values()) {
      await postTransfers(
        await mapRefund({
          occurredAt: "2026-06-22T00:00:00.000Z",
          orderLegs: legs,
        }),
      );
    }
    expect(await accountBalance(modifierAccount(1))).toBe(0);
    expect(await accountBalance(TAX_VAT)).toBe(0);
    expect(await accountBalance(attendeeAccount(1))).toBe(0);
    expect(
      (await allTransfers()).filter(
        (leg) => leg.kind === KIND.refundTaxModifier,
      ),
    ).toHaveLength(2);
    expect(await customerTotals()).toEqual({
      cash: 0,
      deposit_base: 1100,
      total: 1100,
    });
  });
});
