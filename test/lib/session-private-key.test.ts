import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getRequestPrivateKey,
  requireRequestPrivateKey,
  SessionKeyError,
} from "#shared/session-private-key.ts";
import { describeWithEnv, withTestSession } from "#test-utils";

describeWithEnv("shared > session private key", { db: true }, () => {
  test("getRequestPrivateKey returns null with no session in scope", async () => {
    expect(await getRequestPrivateKey()).toBeNull();
  });

  test("requireRequestPrivateKey throws SessionKeyError with no session in scope", async () => {
    await expect(requireRequestPrivateKey()).rejects.toBeInstanceOf(
      SessionKeyError,
    );
  });

  test("resolves the current request's key, which decrypts owner-key data", async () => {
    const sealed = await encryptWithOwnerKey("top secret", settings.publicKey);

    const opened = await withTestSession(async () => {
      const key = await requireRequestPrivateKey();
      return decryptWithOwnerKey(sealed, key);
    });

    expect(opened).toBe("top secret");
  });

  test("the key is scoped to the request: unavailable once the context exits", async () => {
    await withTestSession(async () => {
      expect(await getRequestPrivateKey()).not.toBeNull();
    });
    // Outside the request context the accessor fails closed — no key lingers
    // in scope to leak into an unrelated caller.
    expect(await getRequestPrivateKey()).toBeNull();
  });
});
