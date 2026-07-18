import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import type { EncryptedAttendeeData } from "#shared/db/attendee-types.ts";
import {
  buildAttendeeInsert,
  createAttendeeAtomicImpl,
} from "#shared/db/attendees/create.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { getContactRecord, hashEmail } from "#shared/db/contact-preferences.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const encrypted = {
  created: "2030-01-02T03:04:05.000Z",
  encryptedPiiBlob: "encrypted",
  ticketToken: "ticket",
  ticketTokenIndex: "index",
} as EncryptedAttendeeData;

test("buildAttendeeInsert defaults only a missing kind", () => {
  expect(buildAttendeeInsert(encrypted, { statusId: 9 })).toEqual({
    args: ["2030-01-02T03:04:05.000Z", "attendee", "encrypted", 9, "index"],
    sql: "INSERT INTO attendees (created, kind, pii_blob, status_id, ticket_token_index) VALUES (?, ?, ?, ?, ?)",
  });
});

describeWithEnv("attendee create result fields", { db: true }, () => {
  test("returns every supplied field and derived booking value", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const status = await attendeeStatuses.table.insert({ name: "Fields" });
    const result = await createAttendeeAtomicImpl({
      address: "1 Test Road",
      allowOverbook: true,
      bookings: [
        {
          date: "2030-02-03",
          durationDays: 2,
          listingId: listing.id,
          packageGroupId: 12,
          pricePaid: 345,
          quantity: 0,
        },
      ],
      email: "fields@example.com",
      kind: "servicing",
      name: "Field Tester",
      paymentId: "payment",
      phone: "01234",
      remainingBalance: 67,
      special_instructions: "Near the door",
      statusId: status.id,
      ticketToken: "fixed-ticket",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attendees[0]).toEqual({
      address: "1 Test Road",
      attachment_downloads: 0,
      checked_in: false,
      created: result.attendees[0]!.created,
      date: "2030-02-03",
      email: "fields@example.com",
      end_date: "2030-02-05",
      id: result.attendees[0]!.id,
      kind: "servicing",
      lat: "",
      listing_id: listing.id,
      lng: "",
      name: "Field Tester",
      package_group_id: 12,
      payment_id: "payment",
      phone: "01234",
      pii_blob: "",
      price_paid: "345",
      quantity: 0,
      refunded: false,
      remaining_balance: 67,
      special_instructions: "Near the door",
      split_logistics_agents: false,
      status_id: status.id,
      ticket_token: "fixed-ticket",
      ticket_token_index: result.attendees[0]!.ticket_token_index,
    });
  });

  test("rejects a negative booking even when another booking is valid", async () => {
    const first = await createTestListing();
    const second = await createTestListing();
    expect(
      await createAttendeeAtomicImpl({
        bookings: [
          { listingId: first.id, quantity: 1 },
          { listingId: second.id, quantity: -1 },
        ],
        email: "negative@example.com",
        name: "Negative",
      }),
    ).toEqual({ reason: "capacity_exceeded", success: false });
  });

  test("returns booking and contact defaults for omitted optional fields", async () => {
    const dated = await createTestListing();
    const undated = await createTestListing();
    const result = await createAttendeeAtomicImpl({
      bookings: [
        { date: "2030-03-04", listingId: dated.id },
        { listingId: undated.id },
      ],
      email: "defaults@example.com",
      name: "Defaults",
    });
    if (!result.success) throw new Error("Expected attendee");

    expect(
      result.attendees.map((attendee) => ({
        address: attendee.address,
        date: attendee.date,
        endDate: attendee.end_date,
        kind: attendee.kind,
        packageGroupId: attendee.package_group_id,
        paymentId: attendee.payment_id,
        phone: attendee.phone,
        pricePaid: attendee.price_paid,
        quantity: attendee.quantity,
        remainingBalance: attendee.remaining_balance,
        specialInstructions: attendee.special_instructions,
        statusId: attendee.status_id,
      })),
    ).toEqual([
      {
        address: "",
        date: "2030-03-04",
        endDate: "2030-03-05",
        kind: "attendee",
        packageGroupId: 0,
        paymentId: "",
        phone: "",
        pricePaid: "0",
        quantity: 1,
        remainingBalance: 0,
        specialInstructions: "",
        statusId: null,
      },
      {
        address: "",
        date: null,
        endDate: null,
        kind: "attendee",
        packageGroupId: 0,
        paymentId: "",
        phone: "",
        pricePaid: "0",
        quantity: 1,
        remainingBalance: 0,
        specialInstructions: "",
        statusId: null,
      },
    ]);
    const contact = await getContactRecord(
      await hashEmail("defaults@example.com"),
      await getTestPrivateKey(),
    );
    expect(contact.publicBookingCount).toBe(1);
    expect(contact.adminBookingCount).toBe(0);
    const raw = await getAttendeeRaw(result.attendees[0]!.id);
    if (!raw) throw new Error("Expected stored attendee");
    expect(
      (await decryptAttendeeFields(raw, await getTestPrivateKey())).payment_id,
    ).toBe("");
  });

  test("does not record a booking visit for a zero-quantity-only attendee", async () => {
    const listing = await createTestListing();
    const result = await createAttendeeAtomicImpl({
      allowOverbook: true,
      bookings: [{ listingId: listing.id, quantity: 0 }],
      email: "zero-fields@example.com",
      name: "Zero",
    });
    expect(result.success).toBe(true);
    const contact = await getContactRecord(
      await hashEmail("zero-fields@example.com"),
      await getTestPrivateKey(),
    );
    expect(contact.publicBookingCount).toBe(0);
    expect(contact.adminBookingCount).toBe(0);
  });
});
