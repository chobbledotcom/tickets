/**
 * Test crypto utilities — wallet certificates and related helpers.
 *
 * The static RSA credentials are test-only and deliberately public. Keeping
 * them fixed makes independent signature checks repeatable and avoids slow key
 * generation in every test isolate.
 */

import type { SigningCredentials } from "#shared/apple-wallet.ts";
import type { GoogleWalletCredentials } from "#shared/google-wallet.ts";

const fixture = (filename: string): string =>
  Deno.readTextFileSync(
    new URL(`../fixtures/apple-wallet/${filename}`, import.meta.url),
  );

const SIGNING_KEY_PKCS8 = fixture("signing-key-pkcs8.pem");
const MISMATCHED_SIGNING_KEY = fixture("mismatched-key-pkcs8.pem");
const TEST_CERTS: SigningCredentials = {
  passTypeId: "pass.com.test.tickets",
  signingCert: fixture("signing-cert.pem"),
  signingKey: fixture("signing-key-pkcs1.pem"),
  teamId: "TESTTEAM01",
  wwdrCert: fixture("wwdr-cert.pem"),
};

/** Return the fixed test certificates for Apple Wallet signing. */
export const generateTestCerts = (): SigningCredentials => TEST_CERTS;

export const getMismatchedAppleWalletKey = (): string => MISMATCHED_SIGNING_KEY;

/** Configure all Apple Wallet settings in the database using the test certs.
 *  Shared by the apple-wallet settings tests and the wallet webservice tests. */
export const configureAppleWallet = async (): Promise<void> => {
  const { settings } = await import("#db/settings.ts");
  const testCerts = generateTestCerts();
  await Promise.all([
    settings.update.appleWallet.passTypeId("pass.com.test.tickets"),
    settings.update.appleWallet.teamId("TESTTEAM01"),
    settings.update.appleWallet.signingCert(testCerts.signingCert),
    settings.update.appleWallet.signingKey(testCerts.signingKey),
    settings.update.appleWallet.wwdrCert(testCerts.wwdrCert),
  ]);
};

/** Return fixed Google Wallet credentials using the test RSA key. */
export const generateGoogleTestCreds = (): GoogleWalletCredentials => ({
  issuerId: "1234567890",
  serviceAccountEmail: "test@test-project.iam.gserviceaccount.com",
  serviceAccountKey: SIGNING_KEY_PKCS8,
});

export const getTestDataKey = async (): Promise<CryptoKey> => {
  const { testCookie } = await import("#test-utils/session.ts");
  const { getSessionCookieName } = await import("#shared/cookies.ts");
  const { unwrapKeyWithToken } = await import("#crypto/keys.ts");
  const { getSession } = await import("#db/sessions.ts");
  const cookie = await testCookie();
  const sessionMatch = cookie.match(
    new RegExp(`${getSessionCookieName()}=([^;]+)`),
  );
  const token = sessionMatch![1]!;
  const session = await getSession(token);
  return unwrapKeyWithToken(session!.wrapped_data_key!, token);
};

export const getTestPrivateKey = async (): Promise<CryptoKey> => {
  const { decryptWithKey } = await import("#crypto/encryption.ts");
  const { deriveKEKFromPassword, importPrivateKey, unwrapKey } = await import(
    "#crypto/keys.ts"
  );
  const { getUserByUsername, verifyUserPassword } = await import(
    "#db/users.ts"
  );
  const { settings } = await import("#db/settings.ts");
  const { TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD } = await import(
    "#test-utils/internal.ts"
  );

  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user?.wrapped_data_key) {
    throw new Error("Test setup failed: no wrapped data key");
  }
  const ownerHash = (await verifyUserPassword(user, TEST_ADMIN_PASSWORD))!;
  const kek = await deriveKEKFromPassword(TEST_ADMIN_PASSWORD, ownerHash);
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);
  const wrappedPrivateKey = settings.wrappedPrivateKey;
  if (!wrappedPrivateKey) {
    throw new Error("Test setup failed: no wrapped private key");
  }
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);
  return importPrivateKey(privateKeyJwk);
};
