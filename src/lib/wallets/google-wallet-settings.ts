/**
 * Google Wallet settings — host config (env vars) and settings namespace factories.
 *
 * Extracted from settings.ts to keep wallet-specific logic separate.
 */

import { getEnv } from "#lib/env.ts";
import type { GoogleWalletCredentials } from "#lib/google-wallet.ts";
import {
  createHostConfigOverride,
  type EncryptedUpdateFn,
  mixinWalletConfigResolution,
  type SnapFn,
} from "#lib/wallets/wallet-settings-types.ts";

// ---------------------------------------------------------------------------
// Credential builder
// ---------------------------------------------------------------------------

export const toGoogleCredentials = (
  issuerId: string | undefined,
  serviceAccountEmail: string | undefined,
  serviceAccountKey: string | undefined,
): GoogleWalletCredentials | null =>
  issuerId && serviceAccountEmail && serviceAccountKey
    ? { issuerId, serviceAccountEmail, serviceAccountKey }
    : null;

// ---------------------------------------------------------------------------
// Host config (env-var based, with test override support)
// ---------------------------------------------------------------------------

const hostOverride = createHostConfigOverride<GoogleWalletCredentials>(() =>
  toGoogleCredentials(
    getEnv("GOOGLE_WALLET_ISSUER_ID"),
    getEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"),
    getEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_KEY"),
  ),
);

export const getHostGoogleWalletConfig = hostOverride.getHostConfig;

// ---------------------------------------------------------------------------
// Settings namespace factories
// ---------------------------------------------------------------------------

export const createGoogleWalletReadSettings = (snap: SnapFn) => {
  const obj = {
    get issuerId(): string {
      return snap("google_wallet_issuer_id");
    },
    get serviceAccountEmail(): string {
      return snap("google_wallet_service_account_email");
    },
    get serviceAccountKey(): string {
      return snap("google_wallet_service_account_key");
    },
    get hasDbConfig(): boolean {
      const { issuerId, serviceAccountEmail, serviceAccountKey } = this;
      return !!(issuerId && serviceAccountEmail && serviceAccountKey);
    },
    get dbConfig(): GoogleWalletCredentials | null {
      return toGoogleCredentials(
        this.issuerId,
        this.serviceAccountEmail,
        this.serviceAccountKey,
      );
    },
  };
  mixinWalletConfigResolution<GoogleWalletCredentials>(obj, hostOverride);
  return obj as typeof obj & {
    hostConfig: GoogleWalletCredentials | null;
    config: GoogleWalletCredentials | null;
    hasConfig: boolean;
    setHostConfigForTest: (c: GoogleWalletCredentials | null) => void;
    resetHostConfig: () => void;
  };
};

export const createGoogleWalletUpdateSettings = (
  encryptedUpdate: EncryptedUpdateFn,
) => ({
  issuerId: encryptedUpdate("google_wallet_issuer_id"),
  serviceAccountEmail: encryptedUpdate("google_wallet_service_account_email"),
  serviceAccountKey: encryptedUpdate("google_wallet_service_account_key"),
});
