import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  TAX_VAT,
  WORLD,
} from "#accounting/accounts.ts";
import {
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
  postManualLedgerEntry,
} from "#accounting/manual-entries.ts";
import { mapBooking, mapRefund } from "#accounting/mappers.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#accounting/queries.ts";
import { postTransfers } from "#accounting/store.ts";
import {
  applyAttendeeAtomicEdit,
  loadExistingLines,
} from "#db/attendees/atomic-update.ts";
import { createAttendeeAtomicImpl } from "#db/attendees/create.ts";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { settings } from "#db/settings.ts";
import { attendeeTaxSaveWork } from "#routes/admin/attendee-tax.ts";
import {
  manualAddLedgerPoster,
  postBookingLegsTx,
} from "#shared/checkout-complete.ts";
import { listPriceOrder } from "#shared/checkout-pricing.ts";
import { buildTaxSavePlan, type TaxSavePlan } from "#shared/tax/save.ts";
import { readTaxAssessments } from "#shared/tax/store.ts";
import { NO_TAX, type TaxPolicy } from "#shared/tax/types.ts";
import { keepLine } from "#test/shared/db/attendees/atomic-update/helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import {
  attendeePiiOf,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const added: TaxPolicy = { mode: "add_to_total", rateBasisPoints: 2000 };
const included: TaxPolicy = {
  mode: "calculate_from_total",
  rateBasisPoints: 2000,
};
const occurredAt = "2026-10-27T10:00:00.000Z";

const booking = async (legacy = false) => {
  await settings.update.tax(NO_TAX);
  const listing = await createTestListing({
    maxAttendees: 10,
    name: "Tax place",
    unitPrice: 10000,
  });
  const work = legacy
    ? async (
        tx: Parameters<ReturnType<typeof manualAddLedgerPoster>>[0],
        attendeeId: number,
      ) => {
        await postBookingLegsTx(
          tx,
          attendeeId,
          await mapBooking({
            amountPaid: 0,
            attendeeId,
            bookingFee: 0,
            eventId: String(attendeeId),
            lines: [{ gross: 10000, listingId: listing.id }],
            modifiers: [],
            occurredAt,
          }),
        );
      }
    : manualAddLedgerPoster(listPriceOrder([{ listing, quantity: 1 }]));
  const attendee = bookedAttendee(
    await createAttendeeAtomicImpl(
      {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "tax@example.com",
        name: "Before",
      },
      work,
    ),
  );
  const existing = await loadExistingLines(attendee.id);
  return {
    attendee,
    desired: existing.map(({ key, booking: line }) =>
      keepLine(line.listing_id, key, { quantity: line.quantity }),
    ),
    listing,
  };
};
type Booking = Awaited<ReturnType<typeof booking>>;

/** The save corrected only its own legs: every leg present before it survives. */
const expectOriginalLegsKept = async (
  original: Awaited<ReturnType<typeof allTransfers>>,
) => {
  expect(
    (await allTransfers()).filter((leg) =>
      original.some((old) => old.id === leg.id),
    ),
  ).toEqual(original);
};

const save = async (fixture: Booking, plan?: TaxSavePlan, name = "After") => {
  const current = plan ?? (await buildTaxSavePlan(fixture.attendee.id));
  return applyAttendeeAtomicEdit(
    fixture.attendee.id,
    { ...attendeePiiOf(fixture.attendee), name },
    fixture.desired,
    false,
    await attendeeTaxSaveWork(
      fixture.attendee.id,
      fixture.attendee.status_id,
      true,
      current,
    ),
  );
};

const figures = async (fixture: Booking) => ({
  income: await accountBalance(revenueAccount(fixture.listing.id)),
  owed: -(await accountBalance(attendeeAccount(fixture.attendee.id))),
  tax: await accountBalance(TAX_VAT),
});

describeWithEnv("tax > explicit attendee saves", { db: true }, () => {
  it("leaves old money alone until save and fixes the original basis on a legacy booking", async () => {
    const fixture = await booking(true);
    expect(await readTaxAssessments([fixture.attendee.id])).toEqual([]);
    const original = await allTransfers();
    await settings.update.tax(added);
    expect(await allTransfers()).toEqual(original);
    expect((await buildTaxSavePlan(fixture.attendee.id)).preview).toMatchObject(
      {
        afterBalance: 12000,
        afterTax: 2000,
        beforeBalance: 10000,
        beforeTax: 0,
        changed: true,
      },
    );
    expect((await save(fixture)).success).toBe(true);
    expect(await figures(fixture)).toEqual({
      income: 10000,
      owed: 12000,
      tax: 2000,
    });
    const assessments = await readTaxAssessments([fixture.attendee.id]);
    expect(assessments.map((row) => row.state.revision)).toEqual([0, 1]);
    expect(assessments[1]!.state.assessment.basis).toEqual({
      lines: [{ gross: 10000, listingId: fixture.listing.id }],
      modifiers: [],
    });
  });

  it("replays without a second charge and returns through added, included, off, added", async () => {
    const fixture = await booking();
    const original = await allTransfers();
    await settings.update.tax(added);
    await save(fixture);
    const first = await allTransfers();
    await save(fixture);
    expect(await allTransfers()).toEqual(first);
    await settings.update.tax(included);
    await save(fixture);
    expect(await figures(fixture)).toEqual({
      income: 8333,
      owed: 10000,
      tax: 1667,
    });
    await settings.update.tax(NO_TAX);
    await save(fixture);
    expect(await figures(fixture)).toEqual({
      income: 10000,
      owed: 10000,
      tax: 0,
    });
    await settings.update.tax(added);
    await save(fixture);
    expect(await figures(fixture)).toEqual({
      income: 10000,
      owed: 12000,
      tax: 2000,
    });
    expect(
      (await readTaxAssessments([fixture.attendee.id])).map(
        (row) => row.state.revision,
      ),
    ).toEqual([0, 1, 2, 3, 4]);
    await expectOriginalLegsKept(original);
  });

  it("preserves payments and write-offs instead of taxing the unpaid balance", async () => {
    const fixture = await booking();
    for (const [type, amount] of [
      [MANUAL_ATTENDEE_PAYMENT, 6000],
      [MANUAL_ATTENDEE_WRITEOFF, 1000],
    ] as const) {
      await postManualLedgerEntry({
        account: attendeeAccount(fixture.attendee.id),
        amount,
        occurredAt,
        postedBy: "system",
        type,
      });
    }
    const original = await allTransfers();
    await settings.update.tax(added);
    await save(fixture);
    expect(await figures(fixture)).toEqual({
      income: 10000,
      owed: 5000,
      tax: 2000,
    });
    expect(await accountBalance(WORLD)).toBe(-6000);
    await expectOriginalLegsKept(original);
  });

  it("rejects stale settings without a partial attendee or tax write", async () => {
    const fixture = await booking();
    await settings.update.tax(added);
    const stale = await buildTaxSavePlan(fixture.attendee.id);
    await settings.update.tax(included);
    await expect(save(fixture, stale)).rejects.toThrow(
      "booking_tax_assessments.booking_group",
    );
    expect(await figures(fixture)).toEqual({
      income: 10000,
      owed: 10000,
      tax: 0,
    });
    expect(
      (await getAttendeeOrNull(fixture.attendee.id, await getTestPrivateKey()))!
        .name,
    ).toBe("Before");
  });

  it("rejects the second concurrent assessment and does not duplicate tax", async () => {
    const fixture = await booking();
    await settings.update.tax(added);
    const first = await buildTaxSavePlan(fixture.attendee.id);
    const second = await buildTaxSavePlan(fixture.attendee.id);
    await save(fixture, first);
    await expect(save(fixture, second)).rejects.toThrow(
      "booking_tax_assessments.booking_group",
    );
    expect(await figures(fixture)).toEqual({
      income: 10000,
      owed: 12000,
      tax: 2000,
    });
  });

  it("rolls back contact, status and correction legs when assessment storage fails", async () => {
    const fixture = await booking();
    await settings.update.tax(added);
    const original = await allTransfers();
    await withDbFault(
      "CREATE TRIGGER tax_assessment_fault BEFORE INSERT ON booking_tax_assessments WHEN NEW.revision > 0 BEGIN SELECT RAISE(ABORT, 'tax assessment unavailable'); END",
      "tax_assessment_fault",
      async () => {
        await expect(save(fixture)).rejects.toThrow(
          "tax assessment unavailable",
        );
      },
    );
    expect(await allTransfers()).toEqual(original);
    expect(
      (await getAttendeeOrNull(fixture.attendee.id, await getTestPrivateKey()))!
        .name,
    ).toBe("Before");
    expect(
      (await readTaxAssessments([fixture.attendee.id])).map(
        (row) => row.state.revision,
      ),
    ).toEqual([0]);
  });

  it("does not recreate debt after a legacy refund or accept a pre-refund plan", async () => {
    const fixture = await booking(true);
    await settings.update.tax(added);
    const stale = await buildTaxSavePlan(fixture.attendee.id);
    const original = await transfersByAccount(
      attendeeAccount(fixture.attendee.id),
    );
    await postTransfers(await mapRefund({ occurredAt, orderLegs: original }));
    await expect(save(fixture, stale)).rejects.toThrow(
      "booking_tax_assessments.booking_group",
    );
    await save(fixture);
    expect(await figures(fixture)).toEqual({ income: 0, owed: 0, tax: 0 });
    expect(
      (await readTaxAssessments([fixture.attendee.id])).map(
        (row) => row.state.kind,
      ),
    ).toEqual(["refunded"]);
  });
});
