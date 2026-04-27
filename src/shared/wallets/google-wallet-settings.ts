/**
 * Google Wallet settings — host config (env vars) and settings namespace factories.
 *
 * Extracted from settings.ts to keep wallet-specific logic separate.
 */

import type { GoogleWalletCredentials } from "#shared/google-wallet.ts";
import { createWalletSettingsKit } from "#shared/wallets/wallet-settings-types.ts";

const kit = createWalletSettingsKit<
  GoogleWalletCredentials,
  "issuerId" | "serviceAccountEmail" | "serviceAccountKey"
>({
  build: (v) =>
    v.issuerId && v.serviceAccountEmail && v.serviceAccountKey
      ? {
          issuerId: v.issuerId,
          serviceAccountEmail: v.serviceAccountEmail,
          serviceAccountKey: v.serviceAccountKey,
        }
      : null,
  fields: {
    issuerId: {
      dbKey: "google_wallet_issuer_id",
      envKey: "GOOGLE_WALLET_ISSUER_ID",
    },
    serviceAccountEmail: {
      dbKey: "google_wallet_service_account_email",
      envKey: "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
    },
    serviceAccountKey: {
      dbKey: "google_wallet_service_account_key",
      envKey: "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
    },
  },
});

export const getHostGoogleWalletConfig = kit.getHostConfig;
export const createGoogleWalletReadSettings = kit.createReadSettings;
export const createGoogleWalletUpdateSettings = kit.createUpdateSettings;
