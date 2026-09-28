/** The checkout work key: an independent secret. A database dump plus
 * DB_ENCRYPTION_KEY must not open work sealed under it, and a work key that
 * merely spells the database key is refused. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import {
  decryptCheckoutWork,
  encryptCheckoutWork,
  setCheckoutWorkKeyForTest,
} from "#crypto/checkout-work.ts";
import { setEncryptionKeyForTest } from "#crypto/encryption.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  OTHER_TEST_ENCRYPTION_KEY,
  TEST_CHECKOUT_WORK_KEY,
  TEST_ENCRYPTION_KEY,
} from "#test-utils/internal.ts";

describeWithEnv("checkout work key", { encryptionKey: true }, () => {
  afterEach(() => {
    setEncryptionKeyForTest(TEST_ENCRYPTION_KEY);
    setCheckoutWorkKeyForTest(TEST_CHECKOUT_WORK_KEY);
  });

  test("round-trips a payload through its own wrapped row key", async () => {
    const work = await encryptCheckoutWork("Arriving by bus");

    expect(await decryptCheckoutWork(work)).toBe("Arriving by bus");
  });

  test("seals each row under a different data key", async () => {
    const first = await encryptCheckoutWork("first");
    const second = await encryptCheckoutWork("second");

    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(first.sealed).not.toBe(second.sealed);
  });

  test("refuses a ciphertext sealed under another work key", async () => {
    const work = await encryptCheckoutWork("Arriving by bus");
    setCheckoutWorkKeyForTest(OTHER_TEST_ENCRYPTION_KEY);

    await expect(decryptCheckoutWork(work)).rejects.toThrow();
  });

  test("refuses a work key that spells the database key", async () => {
    setCheckoutWorkKeyForTest(TEST_ENCRYPTION_KEY);

    await expect(encryptCheckoutWork("text")).rejects.toThrow(
      "must differ from DB_ENCRYPTION_KEY",
    );
  });

  test("refuses a missing work key", async () => {
    setCheckoutWorkKeyForTest(null);

    await expect(encryptCheckoutWork("text")).rejects.toThrow(
      "CHECKOUT_WORK_KEY is required",
    );
  });

  test("refuses malformed sealed input loudly", async () => {
    await expect(
      decryptCheckoutWork({ sealed: "not-sealed", wrappedKey: "wk:1:x" }),
    ).rejects.toThrow("Invalid checkout work");
    await expect(
      decryptCheckoutWork({ sealed: "enc:1:x", wrappedKey: "nope" }),
    ).rejects.toThrow("Invalid checkout work");
  });
});
