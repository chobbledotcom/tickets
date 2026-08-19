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
import { encryptWithKey } from "#shared/crypto/encryption.ts";
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import type { WrappedKey } from "#shared/crypto/sealed.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getSealedSumupCheckout,
  getSumupCheckout,
  openSumupCheckout,
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { SUMUP_FIRST_CHECK_MS } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { rejectedError } from "#test-utils/errors.ts";

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

    test("rejects non-string metadata before storing it", async () => {
      await expect(
        storeSumupCheckout(REFERENCE, {
          quantity: 2,
        } as unknown as Record<string, string>),
      ).rejects.toThrow(
        "Invalid value for stored JSON in sumup_checkouts.metadata",
      );
    });

    test("identifies corrupt metadata without exposing its reference", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);
      const row = await rawRow();
      const dataKey = await unwrapKeyWithToken(
        row.wrapped_key as WrappedKey,
        REFERENCE,
      );
      const malformed = await encryptWithKey('{"email":123}', dataKey);
      await getDb().execute(
        "UPDATE sumup_checkouts SET metadata = ? WHERE reference_index = ?",
        [malformed, row.reference_index as string],
      );

      const error = await rejectedError(getSumupCheckout(REFERENCE));
      expect(error.message).toContain(row.reference_index as string);
      expect(error.message).not.toContain(REFERENCE);
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
      expect(await getSealedSumupCheckout("co_abc123")).not.toBeNull();
    });

    test("setSumupCheckoutId schedules the first check three hours out", async () => {
      // Joining the queue and waiting out the retry window are one act: the
      // first ask must not come before SumUp's own retries would have.
      await storeSumupCheckout(REFERENCE, METADATA);
      const before = Date.now();
      await setSumupCheckoutId(REFERENCE, "co_first_check");
      const after = Date.now();

      const { rows } = await getDb().execute(
        "SELECT next_check_at FROM sumup_checkouts WHERE sumup_id = 'co_first_check'",
      );
      const scheduled = Date.parse(String(rows[0]!.next_check_at));
      expect(scheduled).toBeGreaterThanOrEqual(before + SUMUP_FIRST_CHECK_MS);
      expect(scheduled).toBeLessThanOrEqual(after + SUMUP_FIRST_CHECK_MS);
    });

    test("setSumupCheckoutId updates only the matching reference", async () => {
      const otherReference = crypto.randomUUID();
      await storeSumupCheckout(REFERENCE, METADATA);
      await storeSumupCheckout(otherReference, METADATA);

      await setSumupCheckoutId(REFERENCE, "co_target");

      const target = await getSumupCheckout(REFERENCE);
      expect(target!.sumupId).toBe("co_target");
      // The id write must not clobber the row's encrypted metadata.
      expect(target!.metadata).toEqual(METADATA);
      // The other row keeps its unset id.
      expect((await getSumupCheckout(otherReference))!.sumupId).toBe("");
    });

    test("getSealedSumupCheckout rejects ids we never created", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);
      await setSumupCheckoutId(REFERENCE, "co_abc123");

      expect(await getSealedSumupCheckout("co_spam")).toBeNull();
    });

    test("openSumupCheckout opens a sealed row with its own reference", async () => {
      await storeSumupCheckout(REFERENCE, METADATA);
      await setSumupCheckoutId(REFERENCE, "co_abc123");

      const sealed = await getSealedSumupCheckout("co_abc123");
      expect(await openSumupCheckout(sealed!, REFERENCE)).toEqual(METADATA);
    });

    test("openSumupCheckout refuses a reference that names another row", async () => {
      // The row's own index is the proof: a different booking's reference
      // must not decrypt this row's metadata.
      await storeSumupCheckout(REFERENCE, METADATA);
      await setSumupCheckoutId(REFERENCE, "co_abc123");

      const sealed = await getSealedSumupCheckout("co_abc123");
      expect(
        await openSumupCheckout(sealed!, "some-other-reference"),
      ).toBeNull();
    });

    test("setSumupCheckoutId throws when no staged row matches", async () => {
      // Creation must fail before the hosted URL is exposed: with no staged
      // id, every callback for this checkout would be refused as unknown.
      await expect(setSumupCheckoutId(REFERENCE, "co_lost")).rejects.toThrow(
        "expected exactly 1",
      );
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
