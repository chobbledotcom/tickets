/**
 * Test crypto utilities — wallet certificates and related helpers.
 *
 * NOTE: node-forge is imported only in this file. To avoid loading it in
 * workers that don't need wallet certificates, do NOT re-export these
 * functions from the #test-utils barrel. Import directly from
 * "#test-utils/crypto" instead.
 */

import forge from "node-forge";
import { once } from "#fp";
import type { SigningCredentials } from "#shared/apple-wallet.ts";
import type { GoogleWalletCredentials } from "#shared/google-wallet.ts";

function buildTestCerts(): SigningCredentials {
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create a CA cert (WWDR stand-in)
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = keys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(
    caCert.validity.notAfter.getFullYear() + 1,
  );
  const caAttrs = [{ name: "commonName", value: "Test WWDR CA" }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ cA: true, name: "basicConstraints" }]);
  caCert.sign(keys.privateKey, forge.md.sha256.create());

  // Create a signing cert
  const signingKeys = forge.pki.rsa.generateKeyPair(2048);
  const signingCert = forge.pki.createCertificate();
  signingCert.publicKey = signingKeys.publicKey;
  signingCert.serialNumber = "02";
  signingCert.validity.notBefore = new Date();
  signingCert.validity.notAfter = new Date();
  signingCert.validity.notAfter.setFullYear(
    signingCert.validity.notAfter.getFullYear() + 1,
  );
  signingCert.setSubject([{ name: "commonName", value: "Test Pass Signing" }]);
  signingCert.setIssuer(caAttrs);
  signingCert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    passTypeId: "pass.com.test.tickets",
    signingCert: forge.pki.certificateToPem(signingCert),
    signingKey: forge.pki.privateKeyToPem(signingKeys.privateKey),
    teamId: "TESTTEAM01",
    wwdrCert: forge.pki.certificateToPem(caCert),
  };
}

/** Return pre-built test certificates for Apple Wallet signing (built once) */
export const generateTestCerts = once(buildTestCerts);

/** Configure all Apple Wallet settings in the database using the test certs.
 *  Shared by the apple-wallet settings tests and the wallet webservice tests. */
export const configureAppleWallet = async (): Promise<void> => {
  const { settings } = await import("#shared/db/settings.ts");
  const testCerts = generateTestCerts();
  await Promise.all([
    settings.update.appleWallet.passTypeId("pass.com.test.tickets"),
    settings.update.appleWallet.teamId("TESTTEAM01"),
    settings.update.appleWallet.signingCert(testCerts.signingCert),
    settings.update.appleWallet.signingKey(testCerts.signingKey),
    settings.update.appleWallet.wwdrCert(testCerts.wwdrCert),
  ]);
};

function buildGoogleTestCreds(): GoogleWalletCredentials {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const pkcs8Asn1 = forge.pki.wrapRsaPrivateKey(
    forge.pki.privateKeyToAsn1(keys.privateKey),
  );
  const pem = forge.pki.privateKeyInfoToPem(pkcs8Asn1);
  return {
    issuerId: "1234567890",
    serviceAccountEmail: "test@test-project.iam.gserviceaccount.com",
    serviceAccountKey: pem,
  };
}

/** Return pre-built Google Wallet test credentials (built once) */
export const generateGoogleTestCreds = once(buildGoogleTestCreds);

export const getTestDataKey = async (): Promise<CryptoKey> => {
  const { testCookie } = await import("#test-utils/session.ts");
  const { getSessionCookieName } = await import("#shared/cookies.ts");
  const { unwrapKeyWithToken } = await import("#shared/crypto/keys.ts");
  const { getSession } = await import("#shared/db/sessions.ts");
  const cookie = await testCookie();
  const sessionMatch = cookie.match(
    new RegExp(`${getSessionCookieName()}=([^;]+)`),
  );
  const token = sessionMatch![1]!;
  const session = await getSession(token);
  return unwrapKeyWithToken(session!.wrapped_data_key!, token);
};

export const getTestPrivateKey = async (): Promise<CryptoKey> => {
  const { decryptWithKey } = await import("#shared/crypto/encryption.ts");
  const { deriveKEKFromPassword, importPrivateKey, unwrapKey } = await import(
    "#shared/crypto/keys.ts"
  );
  const { getUserByUsername, verifyUserPassword } = await import(
    "#shared/db/users.ts"
  );
  const { settings } = await import("#shared/db/settings.ts");
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
