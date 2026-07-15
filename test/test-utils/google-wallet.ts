/**
 * Google Wallet configuration fixtures shared by the wallet route tests and
 * the admin settings-wallets tests: seed the database settings, or set the
 * host env vars, with the once()-cached test credentials.
 */

import { settings } from "#shared/db/settings.ts";
import { generateGoogleTestCreds } from "#test-utils/crypto.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";

/** Configure all Google Wallet settings in the database */
export const configureGoogleWallet = async (): Promise<void> => {
  const creds = generateGoogleTestCreds();
  await Promise.all([
    settings.update.googleWallet.issuerId(creds.issuerId),
    settings.update.googleWallet.serviceAccountEmail(creds.serviceAccountEmail),
    settings.update.googleWallet.serviceAccountKey(creds.serviceAccountKey),
  ]);
};

/** Set all Google Wallet env vars for the returned scope. */
export const setGoogleWalletEnvVars = (): EnvScope =>
  withEnv({
    GOOGLE_WALLET_ISSUER_ID: "9876543210",
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL:
      "env@env-project.iam.gserviceaccount.com",
    GOOGLE_WALLET_SERVICE_ACCOUNT_KEY:
      generateGoogleTestCreds().serviceAccountKey,
  });
