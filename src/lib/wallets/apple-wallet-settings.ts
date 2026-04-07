/**
 * Apple Wallet settings — host config (env vars) and settings namespace factories.
 *
 * Extracted from settings.ts to keep wallet-specific logic separate.
 */

import type { SigningCredentials } from "#lib/apple-wallet.ts";
import { createWalletSettingsKit } from "#lib/wallets/wallet-settings-types.ts";

const kit = createWalletSettingsKit<
  SigningCredentials,
  "passTypeId" | "teamId" | "signingCert" | "signingKey" | "wwdrCert"
>({
  fields: {
    passTypeId: {
      dbKey: "apple_wallet_pass_type_id",
      envKey: "APPLE_WALLET_PASS_TYPE_ID",
    },
    teamId: {
      dbKey: "apple_wallet_team_id",
      envKey: "APPLE_WALLET_TEAM_ID",
    },
    signingCert: {
      dbKey: "apple_wallet_signing_cert",
      envKey: "APPLE_WALLET_SIGNING_CERT",
    },
    signingKey: {
      dbKey: "apple_wallet_signing_key",
      envKey: "APPLE_WALLET_SIGNING_KEY",
    },
    wwdrCert: {
      dbKey: "apple_wallet_wwdr_cert",
      envKey: "APPLE_WALLET_WWDR_CERT",
    },
  },
  build: (v) =>
    v.passTypeId && v.teamId && v.signingCert && v.signingKey && v.wwdrCert
      ? {
          passTypeId: v.passTypeId,
          teamId: v.teamId,
          signingCert: v.signingCert,
          signingKey: v.signingKey,
          wwdrCert: v.wwdrCert,
        }
      : null,
});

export const getHostAppleWalletConfig = kit.getHostConfig;
export const createAppleWalletReadSettings = kit.createReadSettings;
export const createAppleWalletUpdateSettings = kit.createUpdateSettings;
