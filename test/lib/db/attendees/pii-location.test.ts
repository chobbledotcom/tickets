/**
 * Pinned-location (lat/lng) handling in the attendee PII blob: the operator's
 * pin round-trips through the encrypted blob, blobs without a pin stay
 * unchanged in shape, and a public booking never stores a pin.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildPiiBlob,
  decryptPiiBlob,
  encryptPiiBlob,
  parsePiiBlob,
} from "#shared/db/attendees/pii.ts";
import { settings } from "#shared/db/settings.ts";
import {
  bookAttendee,
  createTestListing,
  decryptFirstAttendee,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

const basePii = {
  address: "10 Downing Street, LONDON, SW1A 2AA",
  email: "pin@example.com",
  lat: "",
  lng: "",
  name: "Pin Person",
  payment_id: "",
  phone: "",
  special_instructions: "",
  ticket_token: "tok_pin",
};

describeWithEnv("db > attendees > pii pinned location", { db: true }, () => {
  test("an unpinned blob carries no la/lo keys at all", () => {
    const blob = JSON.parse(buildPiiBlob(basePii));
    expect("la" in blob).toBe(false);
    expect("lo" in blob).toBe(false);
  });

  test("a pinned blob round-trips its coordinates through parse", () => {
    const parsed = parsePiiBlob(
      buildPiiBlob({ ...basePii, lat: "57.147740", lng: "-2.096323" }),
    );
    expect(parsed.la).toBe("57.147740");
    expect(parsed.lo).toBe("-2.096323");
  });

  test("a pinned blob decrypts back to its exact coordinates", async () => {
    const encrypted = await encryptPiiBlob(
      buildPiiBlob({ ...basePii, lat: "57.147740", lng: "-2.096323" }),
      settings.publicKey,
    );
    const pii = await decryptPiiBlob(encrypted, await getTestPrivateKey(), true);
    expect(pii.lat).toBe("57.147740");
    expect(pii.lng).toBe("-2.096323");
    expect(pii.address).toBe(basePii.address);
  });

  test("a blob saved before pins existed decrypts to empty coordinates", async () => {
    const encrypted = await encryptPiiBlob(
      buildPiiBlob(basePii),
      settings.publicKey,
    );
    const pii = await decryptPiiBlob(encrypted, await getTestPrivateKey(), true);
    expect(pii.lat).toBe("");
    expect(pii.lng).toBe("");
  });

  test("a public booking stores no pinned location", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const result = await bookAttendee(listing, {
      address: "123 Main St, Springfield",
      email: "book@example.com",
      name: "Booked Person",
      quantity: 1,
    });
    expect(result.success).toBe(true);
    const attendee = await decryptFirstAttendee(listing.id);
    expect(attendee.lat).toBe("");
    expect(attendee.lng).toBe("");
  });
});
