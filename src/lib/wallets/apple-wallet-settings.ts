/**
 * Apple Wallet settings — host config (env vars) and settings namespace factories.
 *
 * Extracted from settings.ts to keep wallet-specific logic separate.
 */

import type { SigningCredentials } from "#lib/apple-wallet.ts";
import { getEnv } from "#lib/env.ts";
import {
  createHostConfigOverride,
  type EncryptedUpdateFn,
  mixinWalletConfigResolution,
  type SnapFn,
} from "#lib/wallets/wallet-settings-types.ts";

// ---------------------------------------------------------------------------
// Credential builder
// ---------------------------------------------------------------------------

export const toCredentials = (
  passTypeId: string | undefined,
  teamId: string | undefined,
  signingCert: string | undefined,
  signingKey: string | undefined,
  wwdrCert: string | undefined,
): SigningCredentials | null =>
  passTypeId && teamId && signingCert && signingKey && wwdrCert
    ? { passTypeId, teamId, signingCert, signingKey, wwdrCert }
    : null;

// ---------------------------------------------------------------------------
// Host config (env-var based, with test override support)
// ---------------------------------------------------------------------------

const hostOverride = createHostConfigOverride<SigningCredentials>(() =>
  toCredentials(
    getEnv("APPLE_WALLET_PASS_TYPE_ID"),
    getEnv("APPLE_WALLET_TEAM_ID"),
    getEnv("APPLE_WALLET_SIGNING_CERT"),
    getEnv("APPLE_WALLET_SIGNING_KEY"),
    getEnv("APPLE_WALLET_WWDR_CERT"),
  ),
);

export const getHostAppleWalletConfig = hostOverride.getHostConfig;

// ---------------------------------------------------------------------------
// Settings namespace factories
// ---------------------------------------------------------------------------

export const createAppleWalletReadSettings = (snap: SnapFn) => {
  const obj = {
    get passTypeId(): string {
      return snap("apple_wallet_pass_type_id");
    },
    get teamId(): string {
      return snap("apple_wallet_team_id");
    },
    get signingCert(): string {
      return snap("apple_wallet_signing_cert");
    },
    get signingKey(): string {
      return snap("apple_wallet_signing_key");
    },
    get wwdrCert(): string {
      return snap("apple_wallet_wwdr_cert");
    },
    get hasDbConfig(): boolean {
      return !!(
        this.passTypeId &&
        this.teamId &&
        this.signingCert &&
        this.signingKey &&
        this.wwdrCert
      );
    },
    get dbConfig(): SigningCredentials | null {
      return toCredentials(
        this.passTypeId,
        this.teamId,
        this.signingCert,
        this.signingKey,
        this.wwdrCert,
      );
    },
  };
  mixinWalletConfigResolution<SigningCredentials>(obj, hostOverride);
  return obj as typeof obj & {
    hostConfig: SigningCredentials | null;
    config: SigningCredentials | null;
    hasConfig: boolean;
    setHostConfigForTest: (c: SigningCredentials | null) => void;
    resetHostConfig: () => void;
  };
};

export const createAppleWalletUpdateSettings = (
  encryptedUpdate: EncryptedUpdateFn,
) => ({
  passTypeId: encryptedUpdate("apple_wallet_pass_type_id"),
  teamId: encryptedUpdate("apple_wallet_team_id"),
  signingCert: encryptedUpdate("apple_wallet_signing_cert"),
  signingKey: encryptedUpdate("apple_wallet_signing_key"),
  wwdrCert: encryptedUpdate("apple_wallet_wwdr_cert"),
});
