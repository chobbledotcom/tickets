import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import type { WrappedKey } from "#shared/crypto/sealed.ts";
import { getDb } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getRequestPrivateKey,
  getSessionPrivateKey,
  requireRequestPrivateKey,
  SessionKeyError,
} from "#shared/session-private-key.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withTestSession } from "#test-utils/session.ts";

describeWithEnv("shared > session private key", { db: true }, () => {
  test("returns null when an explicit session has no wrapped data key", async () => {
    expect(
      await getSessionPrivateKey({ token: "token", wrappedDataKey: null }),
    ).toBeNull();
  });

  test("returns null when the stored private key is missing", async () => {
    await getDb().execute(
      "DELETE FROM settings WHERE key = 'wrapped_private_key'",
    );
    settings.invalidateCache();
    expect(
      await getSessionPrivateKey({
        token: "token",
        wrappedDataKey: "wrapped" as WrappedKey,
      }),
    ).toBeNull();
  });

  test("returns null when an explicit session key cannot be unwrapped", async () => {
    expect(
      await getSessionPrivateKey({
        token: "token",
        wrappedDataKey: "corrupt-key-data" as WrappedKey,
      }),
    ).toBeNull();
  });

  test("getRequestPrivateKey returns null with no session in scope", async () => {
    expect(await getRequestPrivateKey()).toBeNull();
  });

  test("requireRequestPrivateKey throws SessionKeyError with no session in scope", async () => {
    await expect(requireRequestPrivateKey()).rejects.toBeInstanceOf(
      SessionKeyError,
    );
  });

  test("SessionKeyError reports its own name, not the generic Error", () => {
    expect(new SessionKeyError().name).toBe("SessionKeyError");
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
