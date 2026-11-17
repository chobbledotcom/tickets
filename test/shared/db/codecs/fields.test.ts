/**
 * Tests for `src/shared/db/codecs/fields.ts`: the codec of each field kind,
 * read through the listing and status field lists.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { fieldCodecs } from "#db/codecs/fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const listing = fieldCodecs("listings", LISTING_FIELDS);

const sealedText = (text: string): Promise<EnvKeyEncrypted> => encrypt(text);

describe("field codecs", () => {
  test("names each stored JSON field by its table when its value is invalid", () => {
    expect(() => listing.bookable_days.decode("bad json", 1)).toThrow(
      "listings.bookable_days",
    );
  });

  test("gives no codec to a field kind with no column of its own", () => {
    expect(Object.keys(listing)).not.toContain("day_prices");
  });

  test("stores a switch as 1 or 0", () => {
    const status = fieldCodecs("attendee_statuses", STATUS_FIELDS);
    expect([
      status.is_reservation.encode(true),
      status.is_reservation.decode(0, 1),
    ]).toEqual([1, false]);
  });

  test("keeps the contact-field tokens tidy and clamps the duration", () => {
    expect([
      listing.fields.encode(" email , phone " as never),
      listing.duration_days.encode(9999),
    ]).toEqual(["email,phone", 90]);
  });
});

describeWithEnv("field codecs > sealed values", { encryptionKey: true }, () => {
  test("stores a listing date as sealed UTC text, and reads it back", async () => {
    const written = await listing.date.encode("2026-06-01T10:00+01:00");

    expect(await decrypt(written)).toBe("2026-06-01T09:00:00.000Z");
    expect(await listing.date.decode(written, 1)).toBe(
      "2026-06-01T09:00:00.000Z",
    );
    expect(() => listing.date.encode("not a time")).toThrow(
      "date has invalid datetime: not a time",
    );
  });

  test("names a stored datetime that it cannot read", async () => {
    await expect(
      listing.date.decode(await sealedText("not a time"), 1),
    ).rejects.toThrow("stored datetime has invalid datetime: not a time");
  });

  test("reads a stored date without an offset as UTC", async () => {
    expect(
      await listing.date.decode(await sealedText("2026-06-01T10:00"), 1),
    ).toBe("2026-06-01T10:00:00.000Z");
  });

  test("reads an empty closing time as no closing time", async () => {
    const closesAt = listing.closes_at;
    const written = await closesAt.encode("2026-06-01T10:00Z");

    expect([
      await closesAt.decode(await sealedText(""), 1),
      await closesAt.decode(await sealedText("2026-06-01T10:00Z"), 1),
      await decrypt(written),
    ]).toEqual([null, "2026-06-01T10:00:00.000Z", "2026-06-01T10:00:00.000Z"]);
  });

  test("stores no closing time as sealed empty text", async () => {
    const written = await listing.closes_at.encode(null);

    expect([
      await decrypt(written),
      await listing.closes_at.decode(written, 1),
    ]).toEqual(["", null]);
  });

  test("seals private text and keeps an empty text empty", async () => {
    const written = await listing.location.encode("Hall");

    expect([
      await decrypt(written as EnvKeyEncrypted),
      await listing.location.encode(""),
    ]).toEqual(["Hall", ""]);
  });
});
