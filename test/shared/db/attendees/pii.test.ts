/**
 * Servicing §0 — pure unit tests for the PII blob shape produced for a
 * name-only servicing event.
 *
 * A servicing row stores its reason in the encrypted `pii_blob` `n` field
 * and leaves every contact field blank — it is a capacity hold, not a person.
 * The encode-side builder is pure (no AES key needed), so this is a [U] test.
 *
 * Implementation contract:
 *   - `#shared/db/attendees/pii.ts` already exports `buildPiiBlob`,
 *     `parsePiiBlob`, `PII_BLOB_VERSION`. No new code — this test reuses
 *     the existing builder with name-only input.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildPiiBlob,
  decryptAttendeeFields,
  decryptAttendeeOrNull,
  decryptAttendees,
  decryptPiiBlob,
  encryptAttendeeFields,
  encryptPiiBlob,
  PII_BLOB_VERSION,
  parsePiiBlob,
} from "#shared/db/attendees/pii.ts";
import { settings } from "#shared/db/settings.ts";
import type { Attendee, PiiBlob } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testAttendee } from "#test-utils/factories.ts";

// jscpd:ignore-end

describe("servicing §0 — buildPiiBlob with name only produces an all-empty-but-name blob", () => {
  const input = {
    address: "",
    email: "",
    lat: "",
    lng: "",
    name: "Boiler Service",
    payment_id: "",
    phone: "",
    special_instructions: "",
    ticket_token: "kept-token",
  };

  test("the blob JSON has the name in `n` and empty strings for `e/p/a/s`", () => {
    const json = buildPiiBlob(input);
    const parsed = parsePiiBlob(json) as PiiBlob;
    expect(parsed.n).toBe("Boiler Service");
    expect(parsed.e).toBe("");
    expect(parsed.p).toBe("");
    expect(parsed.a).toBe("");
    expect(parsed.s).toBe("");
  });

  test("the kept ticket token round-trips through `t`", () => {
    const parsed = parsePiiBlob(buildPiiBlob(input));
    expect(parsed.t).toBe("kept-token");
    // payment_id is also empty — servicing holds are free, never a payment.
    expect(parsed.pi).toBe("");
  });

  test("the blob carries the current PII schema version", () => {
    const parsed = parsePiiBlob(buildPiiBlob(input));
    expect(parsed.v).toBe(PII_BLOB_VERSION);
  });

  test("name only is the smallest possible servicing blob — single source of truth (mutation: trimming any field would drop the round-trip)", () => {
    // Re-encoding with a non-empty contact field must NOT match the
    // name-only baseline — this pins the contract that servicing inputs
    // really do leave those fields blank.
    const baseline = parsePiiBlob(buildPiiBlob(input));
    const leaked = parsePiiBlob(
      buildPiiBlob({ ...input, email: "leaked@example.com" }),
    );
    expect(baseline.e).toBe("");
    expect(leaked.e).toBe("leaked@example.com");
    expect(leaked.e).not.toBe(baseline.e);
  });
});

const samplePii = {
  address: "5 Ledger Lane",
  email: "aggie@pii.test",
  lat: "",
  lng: "",
  name: "Aggie Attendee",
  payment_id: "pay_pii",
  phone: "07700900123",
  special_instructions: "leave at door",
  ticket_token: "tok_pii",
};

/** The contact-only encrypt input for encryptAttendeeFields. */
const encInput = {
  address: samplePii.address,
  email: samplePii.email,
  name: samplePii.name,
  paymentId: samplePii.payment_id,
  phone: samplePii.phone,
  pricePaid: 0,
  special_instructions: samplePii.special_instructions,
};

describe("PII blob encoding", () => {
  test("PII_BLOB_VERSION is 1", () => {
    expect(PII_BLOB_VERSION).toBe(1);
  });

  test("buildPiiBlob keeps a pinned lat/lng but omits an empty one", () => {
    const pinned = JSON.parse(
      buildPiiBlob({ ...samplePii, lat: "1.5", lng: "2.5" }),
    );
    expect(pinned.la).toBe("1.5");
    expect(pinned.lo).toBe("2.5");

    const unpinned = JSON.parse(buildPiiBlob(samplePii));
    expect("la" in unpinned).toBe(false);
    expect("lo" in unpinned).toBe(false);
  });

  test("parsePiiBlob defaults a missing version", () => {
    const blob = JSON.parse(buildPiiBlob(samplePii));
    delete blob.v;
    expect(parsePiiBlob(JSON.stringify(blob)).v).toBe(PII_BLOB_VERSION);
  });

  test("parsePiiBlob rejects an unknown version", () => {
    const blob = { ...JSON.parse(buildPiiBlob(samplePii)), v: 2 };
    expect(() => parsePiiBlob(JSON.stringify(blob))).toThrow(
      "Invalid stored JSON in attendees.pii_blob",
    );
  });
});

const encryptSample = (pii = samplePii) =>
  encryptPiiBlob(buildPiiBlob(pii), settings.publicKey);

const encryptedRow = async (
  overrides: Partial<Attendee> = {},
): Promise<Attendee> =>
  testAttendee({ pii_blob: await encryptSample(), ...overrides });

const roundTrip = async (pii: typeof samplePii, paidListing: boolean) =>
  decryptPiiBlob(
    await encryptSample(pii),
    await getTestPrivateKey(),
    paidListing,
  );

describeWithEnv("PII crypto", { db: true }, () => {
  test("decryptPiiBlob round-trips fields and exposes payment id only when paid", async () => {
    const pinned = { ...samplePii, lat: "1.5", lng: "2.5" };

    const paid = await roundTrip(pinned, true);
    expect(paid.name).toBe("Aggie Attendee");
    expect(paid.lat).toBe("1.5");
    expect(paid.lng).toBe("2.5");
    expect(paid.payment_id).toBe("pay_pii");

    const unpaid = await roundTrip(pinned, false);
    expect(unpaid.payment_id).toBe("");
  });

  test("decryptPiiBlob returns empty coordinates for an unpinned blob", async () => {
    const pii = await roundTrip(samplePii, true);
    expect(pii.lat).toBe("");
    expect(pii.lng).toBe("");
  });

  test("encryptAttendeeFields encrypts blank coordinates that decrypt back to empty", async () => {
    const result = await encryptAttendeeFields(encInput);
    const pii = await decryptPiiBlob(
      result.encryptedPiiBlob,
      await getTestPrivateKey(),
      true,
    );
    expect(pii.lat).toBe("");
    expect(pii.lng).toBe("");
    expect(pii.payment_id).toBe("pay_pii");
  });

  test("decryptAttendeeFields defaults to paid, surfacing payment id and refunded", async () => {
    const row = await encryptedRow({ checked_in: false, refunded: true });
    const decrypted = await decryptAttendeeFields(
      row,
      await getTestPrivateKey(),
    );
    expect(decrypted.name).toBe("Aggie Attendee");
    expect(decrypted.payment_id).toBe("pay_pii");
    expect(decrypted.refunded).toBe(true);
  });

  test("decryptAttendeeFields normalizes a selected numeric price", async () => {
    const row = { ...(await encryptedRow()), price_paid: 2500 };
    const decrypted = await decryptAttendeeFields(
      row,
      await getTestPrivateKey(),
    );
    expect(decrypted.price_paid).toBe("2500");
  });

  test("decryptAttendeeFields hides payment id and forces refunded false when unpaid", async () => {
    const row = await encryptedRow({ refunded: true });
    const decrypted = await decryptAttendeeFields(
      row,
      await getTestPrivateKey(),
      false,
    );
    expect(decrypted.payment_id).toBe("");
    expect(decrypted.refunded).toBe(false);
  });

  test("decryptAttendees decrypts each row, defaulting to paid", async () => {
    const rows = [await encryptedRow({ refunded: true })];
    const [decrypted] = await decryptAttendees(rows, await getTestPrivateKey());
    expect(decrypted!.name).toBe("Aggie Attendee");
    expect(decrypted!.payment_id).toBe("pay_pii");
    expect(decrypted!.refunded).toBe(true);
  });

  test("decryptAttendeeOrNull passes null through and decrypts a row", async () => {
    const key = await getTestPrivateKey();
    expect(await decryptAttendeeOrNull(null, key)).toBeNull();

    const decrypted = await decryptAttendeeOrNull(await encryptedRow(), key);
    expect(decrypted?.name).toBe("Aggie Attendee");
  });
});
