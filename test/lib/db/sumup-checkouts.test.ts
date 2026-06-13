/**
 * Tests for the encrypted SumUp checkout staging store.
 *
 * Beyond the store/retrieve round-trip, these tests assert the at-rest
 * security property that motivated the design: the stored row must contain
 * no plaintext PII and no plaintext checkout reference, so a database dump
 * alone cannot decrypt the staged metadata.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  getSumupCheckout,
  hasSumupCheckoutId,
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { describeWithEnv } from "#test-utils";

const REFERENCE = "9c1f7a52-1b3e-4f6d-8a2c-5e9d0b4c7a31";

const METADATA = {
  _origin: "example.com",
  address: "123 High Street, London",
  email: "alice@example.com",
  items: '[{"e":1,"q":2,"p":1000}]',
  name: "Alice Example",
  phone: "+44 7700 900000",
};

/** Fetch the single raw stored row (all columns) for at-rest inspection. */
const rawRow = async (): Promise<Record<string, unknown>> => {
  const { rows } = await getDb().execute(
    "SELECT reference_index, wrapped_key, metadata, sumup_id, created_at FROM sumup_checkouts",
  );
  expect(rows.length).toBe(1);
  return rows[0] as Record<string, unknown>;
};

describeWithEnv("db > sumup-checkouts", { db: true }, () => {
  describe("round-trip", () => {
    test("returns the exact metadata that was stored", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);

      const result = await getSumupCheckout(REFERENCE);

      expect(result!.metadata).toEqual(METADATA);
      expect(result!.sumupId).toBe("");
    });

    test("returns null for an unknown reference", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);

      const result = await getSumupCheckout(crypto.randomUUID());

      expect(result).toBeNull();
    });

    test("keeps rows isolated per reference", async () => {
      const otherReference = crypto.randomUUID();
      const otherMetadata = { ...METADATA, name: "Bob Other" };
      await storeSumupCheckout(REFERENCE, METADATA);
      await storeSumupCheckout(otherReference, otherMetadata);

      expect((await getSumupCheckout(REFERENCE))!.metadata).toEqual(METADATA);
      expect((await getSumupCheckout(otherReference))!.metadata).toEqual(
        otherMetadata,
      );
    });
  });

  describe("sumup id mapping", () => {
    test("setSumupCheckoutId records the id for later lookups", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);
      await setSumupCheckoutId(REFERENCE, "co_abc123");

      expect((await getSumupCheckout(REFERENCE))!.sumupId).toBe("co_abc123");
      expect(await hasSumupCheckoutId("co_abc123")).toBe(true);
    });

    test("hasSumupCheckoutId rejects ids we never created", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);
      await setSumupCheckoutId(REFERENCE, "co_abc123");

      expect(await hasSumupCheckoutId("co_spam")).toBe(false);
    });
  });

  describe("at-rest properties", () => {
    test("stores no plaintext PII in any column", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);

      const row = await rawRow();
      const atRest = JSON.stringify(row);

      expect(atRest).not.toContain(METADATA.email);
      expect(atRest).not.toContain(METADATA.name);
      expect(atRest).not.toContain(METADATA.phone);
      expect(atRest).not.toContain(METADATA.address);
    });

    test("stores no plaintext checkout reference in any column", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);
      await setSumupCheckoutId(REFERENCE, "co_abc123");

      const row = await rawRow();

      expect(JSON.stringify(row)).not.toContain(REFERENCE);
      expect(row.reference_index).not.toBe(REFERENCE);
    });

    test("encrypts the same metadata differently per row (fresh data keys)", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);
      await storeSumupCheckout(crypto.randomUUID(), METADATA);

      const { rows } = await getDb().execute(
        "SELECT metadata, wrapped_key FROM sumup_checkouts",
      );

      expect(rows.length).toBe(2);
      expect(rows[0]!.metadata).not.toBe(rows[1]!.metadata);
      expect(rows[0]!.wrapped_key).not.toBe(rows[1]!.wrapped_key);
    });
  });
});
