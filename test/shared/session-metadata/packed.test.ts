/** A Square checkout made before orders were sealed packed its small fields
 * into one `b` entry. It can still be paid, so the webhook reads it back. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { extractSessionMetadata } from "#shared/session-metadata.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";

const packed = (fields: Record<string, unknown>) =>
  wireMetadata({
    b: JSON.stringify(fields),
    email: "a@b.com",
    items: "[]",
    name: "Al",
  });

describe("reading a packed `b` entry", () => {
  test("merges every packed field back to the top level", () => {
    const fields = {
      balance_attendee_id: "42",
      date: "2026-07-01",
      day_count: "3",
      phone: "555",
      reservation_amount: "10%",
      site_token_index: "hashed-index",
      tax_policy: '{"mode":"none"}',
    };

    const extracted = extractSessionMetadata(packed(fields));

    expect(extracted).toMatchObject({ ...fields, email: "a@b.com" });
  });

  test("an empty packed field leaves the top-level value in place", () => {
    const extracted = extractSessionMetadata(
      wireMetadata({
        b: JSON.stringify({ phone: "" }),
        email: "a@b.com",
        items: "[]",
        name: "Al",
        phone: "555",
      }),
    );

    expect(extracted.phone).toBe("555");
  });

  test("does not read a field that the packed entry never carried", () => {
    const extracted = extractSessionMetadata(
      packed({ address: "12 Some Street", name: "Mallory" }),
    );

    expect(extracted.address).toBe("");
    expect(extracted.name).toBe("Al");
  });

  test("reads a malformed `b` as no packed fields, and never throws", () => {
    const extracted = extractSessionMetadata(
      wireMetadata({
        b: "not json{",
        email: "a@b.com",
        items: "[]",
        name: "Al",
      }),
    );

    expect(extracted.phone).toBe("");
    expect(extracted.date).toBe("");
    expect(extracted.email).toBe("a@b.com");
  });

  test("ignores a `b` that is not an object", () => {
    for (const b of ["123", "null", '"a string"']) {
      const extracted = extractSessionMetadata(
        wireMetadata({ b, items: "[]", name: "Al" }),
      );
      expect(extracted.phone).toBe("");
    }
  });

  test("drops a packed field that is not text, and keeps its text siblings", () => {
    const extracted = extractSessionMetadata(
      packed({ date: "2026-07-01", phone: 123 }),
    );

    expect(extracted.phone).toBe("");
    expect(extracted.date).toBe("2026-07-01");
  });
});
