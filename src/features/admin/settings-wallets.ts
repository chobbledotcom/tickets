/**
 * Admin wallet settings routes - Apple Wallet and Google Wallet configuration
 * Owner-only access enforced via settingsHandler
 */

import {
  processSecretField,
  type SecretFieldResult,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#shared/apple-wallet.ts";
import { settings } from "#shared/db/settings.ts";
import { isValidGooglePrivateKey } from "#shared/google-wallet.ts";

/**
 * Handle POST /admin/settings/apple-wallet - owner only
 */
type AppleWalletFormData = {
  passTypeId: string;
  teamId: string;
  cert: SecretFieldResult;
  key: SecretFieldResult;
  wwdr: SecretFieldResult;
};

const isAllCleared = (d: AppleWalletFormData): boolean =>
  !d.passTypeId &&
  !d.teamId &&
  d.cert.action === "cleared" &&
  d.key.action === "cleared" &&
  d.wwdr.action === "cleared";

export const handleAppleWalletPost = settingsHandler<AppleWalletFormData>({
  advanced: true,
  extract: (form) => ({
    cert: processSecretField(form, "apple_wallet_signing_cert"),
    key: processSecretField(form, "apple_wallet_signing_key"),
    passTypeId: form.getString("apple_wallet_pass_type_id"),
    teamId: form.getString("apple_wallet_team_id"),
    wwdr: processSecretField(form, "apple_wallet_wwdr_cert"),
  }),
  formId: "settings-apple-wallet",
  label: "Apple Wallet configuration",
  log: (d) =>
    isAllCleared(d)
      ? "Apple Wallet configuration cleared"
      : "Apple Wallet configuration updated",
  save: async (d) => {
    if (isAllCleared(d)) {
      await Promise.all([
        settings.update.appleWallet.passTypeId(""),
        settings.update.appleWallet.teamId(""),
        settings.update.appleWallet.signingCert(""),
        settings.update.appleWallet.signingKey(""),
        settings.update.appleWallet.wwdrCert(""),
      ]);
      return;
    }
    await settings.update.appleWallet.passTypeId(d.passTypeId);
    await settings.update.appleWallet.teamId(d.teamId);
    if (d.cert.action === "provided") {
      await settings.update.appleWallet.signingCert(d.cert.value);
    }
    if (d.key.action === "provided") {
      await settings.update.appleWallet.signingKey(d.key.value);
    }
    if (d.wwdr.action === "provided") {
      await settings.update.appleWallet.wwdrCert(d.wwdr.value);
    }
  },
  validate: (d) => {
    if (isAllCleared(d)) return null;
    if (!d.passTypeId) return "Pass Type ID is required";
    if (!d.teamId) return "Team ID is required";
    if (!settings.appleWallet.hasDbConfig) {
      const requiredError = validateAppleWalletRequiredSecrets(d);
      if (requiredError) return requiredError;
    }
    return validateAppleWalletPemFields(d);
  },
});

/** Ensure required secrets are provided when no DB config exists */
const validateAppleWalletRequiredSecrets = (
  d: AppleWalletFormData,
): string | null => {
  if (d.cert.action !== "provided") return "Signing certificate is required";
  if (d.key.action !== "provided") return "Signing private key is required";
  if (d.wwdr.action !== "provided") return "WWDR certificate is required";
  return null;
};

/** Validate PEM structure of provided Apple Wallet secret fields */
const validateAppleWalletPemFields = (
  d: AppleWalletFormData,
): string | null => {
  if (d.cert.action === "provided" && !isValidPemCertificate(d.cert.value)) {
    return "Signing certificate is not a valid PEM certificate";
  }
  if (d.key.action === "provided" && !isValidPemPrivateKey(d.key.value)) {
    return "Signing private key is not a valid PEM private key";
  }
  if (d.wwdr.action === "provided" && !isValidPemCertificate(d.wwdr.value)) {
    return "WWDR certificate is not a valid PEM certificate";
  }
  return null;
};

/**
 * Handle POST /admin/settings/google-wallet - owner only
 */
type GoogleWalletFormData = {
  issuerId: string;
  email: string;
  key: SecretFieldResult;
};

const isGoogleWalletCleared = (d: GoogleWalletFormData): boolean =>
  !d.issuerId && !d.email && d.key.action === "cleared";

export const handleGoogleWalletPost = settingsHandler<GoogleWalletFormData>({
  advanced: true,
  extract: (form) => ({
    email: form.getString("google_wallet_service_account_email"),
    issuerId: form.getString("google_wallet_issuer_id"),
    key: processSecretField(form, "google_wallet_service_account_key"),
  }),
  formId: "settings-google-wallet",
  label: "Google Wallet configuration",
  log: (d) =>
    isGoogleWalletCleared(d)
      ? "Google Wallet configuration cleared"
      : "Google Wallet configuration updated",
  save: async (d) => {
    if (isGoogleWalletCleared(d)) {
      await Promise.all([
        settings.update.googleWallet.issuerId(""),
        settings.update.googleWallet.serviceAccountEmail(""),
        settings.update.googleWallet.serviceAccountKey(""),
      ]);
      return;
    }
    await settings.update.googleWallet.issuerId(d.issuerId);
    await settings.update.googleWallet.serviceAccountEmail(d.email);
    if (d.key.action === "provided") {
      await settings.update.googleWallet.serviceAccountKey(d.key.value);
    }
  },
  validate: async (d) => {
    if (isGoogleWalletCleared(d)) return null;
    if (!d.issuerId) return "Issuer ID is required";
    if (!d.email) return "Service account email is required";
    if (!settings.googleWallet.hasDbConfig && d.key.action !== "provided") {
      return "Service account private key is required";
    }
    if (
      d.key.action === "provided" &&
      !(await isValidGooglePrivateKey(d.key.value))
    ) {
      return "Service account private key is not a valid PEM private key";
    }
    return null;
  },
});
