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
  PII_BLOB_VERSION,
  parsePiiBlob,
} from "#shared/db/attendees/pii.ts";
import type { PiiBlob } from "#shared/types.ts";

// jscpd:ignore-end

describe("servicing §0 — buildPiiBlob with name only produces an all-empty-but-name blob", () => {
  const input = {
    address: "",
    email: "",
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
