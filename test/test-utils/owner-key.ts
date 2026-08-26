/**
 * The test owner's data key, unwrapped from the owner's own password the way
 * the login flow does it.
 *
 * Setup creates the owner at the v2 (password-bound) KEK scheme, so its KEK is
 * salted with the owner's stored password hash. Every helper that wraps the
 * key for a *new* user — a manager, an agent, a session — starts here.
 */

export const getOwnerDataKey = async (): Promise<CryptoKey> => {
  const { deriveKEKFromPassword, unwrapKey } = await import("#crypto/keys.ts");
  const { getUserByUsername, verifyUserPassword } = await import(
    "#db/users.ts"
  );
  const { TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME } = await import(
    "#test-utils/internal.ts"
  );
  const owner = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!owner?.wrapped_data_key) {
    throw new Error("Test owner has no wrapped data key");
  }
  const ownerHash = (await verifyUserPassword(owner, TEST_ADMIN_PASSWORD))!;
  const kek = await deriveKEKFromPassword(TEST_ADMIN_PASSWORD, ownerHash);
  return unwrapKey(owner.wrapped_data_key, kek);
};
