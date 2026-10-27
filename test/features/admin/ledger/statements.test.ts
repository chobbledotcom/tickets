/** The account-statement loader's memo handling: an owner-key-encrypted memo
 * (an API-created adjustment description) decrypts for display, and a
 * PII-free plaintext memo (a refund reason code) stays as stored. */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { readableMemo } from "#routes/admin/ledger/statements.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

describe("readableMemo", () => {
  beforeAll(setupTestEncryptionKey);

  test("decrypts an owner-key-encrypted memo for display", async () => {
    expect(await readableMemo(await encrypt("Delivery"))).toBe("Delivery");
  });

  test("leaves a plaintext memo (a PII-free reason code) untouched", async () => {
    expect(await readableMemo("provider refund")).toBe("provider refund");
  });
});
