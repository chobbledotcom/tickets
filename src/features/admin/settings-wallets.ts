/**
 * Admin wallet settings routes - Apple Wallet and Google Wallet configuration
 * Owner-only access enforced via settingsHandler
 */

import { firstProblem } from "#fp";
import { t } from "#i18n";
import {
  processSecretField,
  type SecretFieldResult,
  saveSecret,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
import {
  isValidAppleCertificate,
  isValidCertificate,
} from "#shared/apple-wallet/certificate.ts";
import { isValidAppleSigningPair } from "#shared/apple-wallet/cms.ts";
import { isValidRsaPrivateKey } from "#shared/crypto/rsa-private-key.ts";
import { settings } from "#shared/db/settings.ts";

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
  log: (d) =>
    isAllCleared(d)
      ? t("success.apple_wallet_cleared")
      : t("success.apple_wallet_updated"),
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
    await saveSecret(d.cert, settings.update.appleWallet.signingCert);
    await saveSecret(d.key, settings.update.appleWallet.signingKey);
    await saveSecret(d.wwdr, settings.update.appleWallet.wwdrCert);
  },
  validate: async (d) => {
    if (isAllCleared(d)) return null;
    if (!d.passTypeId) return t("error.apple_pass_type_id_required");
    if (!d.teamId) return t("error.apple_team_id_required");
    if (!settings.appleWallet.hasDbConfig) {
      // No saved config to fall back on, so every secret must be uploaded now.
      const missing = await firstAppleSecretProblem(d)((field, secret) =>
        secret.action === "provided" ? null : t(field.missingKey),
      );
      if (missing) return missing;
    }
    const invalidSecret = await firstAppleSecretProblem(d)(
      async (field, secret) =>
        (await field.looksValid(
          effectiveSecretValue(secret, field.savedValue()),
        ))
          ? null
          : t(field.invalidKey),
    );
    if (invalidSecret) return invalidSecret;
    const signingCert = effectiveSecretValue(
      d.cert,
      settings.appleWallet.signingCert,
    );
    const signingKey = effectiveSecretValue(
      d.key,
      settings.appleWallet.signingKey,
    );
    return (await isValidAppleSigningPair(signingCert, signingKey))
      ? null
      : t("error.apple_signing_pair_mismatch");
  },
});

/** The uploaded secret, or the saved value when the masked field was kept. */
const effectiveSecretValue = (
  secret: SecretFieldResult,
  saved: string,
): string => (secret.action === "provided" ? secret.value : saved);

/** One Apple Wallet secret upload, described as data: how to read it from the
 * form, where to load its saved value, and how to validate it. */
type AppleSecretField = {
  fromForm: (d: AppleWalletFormData) => SecretFieldResult;
  invalidKey: string;
  looksValid: (value: string) => boolean | Promise<boolean>;
  missingKey: string;
  savedValue: () => string;
};

/** The three secret uploads on the Apple Wallet form. */
const APPLE_SECRET_FIELDS = [
  {
    fromForm: (d) => d.cert,
    invalidKey: "error.apple_signing_cert_invalid",
    looksValid: isValidAppleCertificate,
    missingKey: "error.apple_signing_cert_required",
    savedValue: () => settings.appleWallet.signingCert,
  },
  {
    fromForm: (d) => d.key,
    invalidKey: "error.apple_signing_key_invalid",
    looksValid: isValidRsaPrivateKey,
    missingKey: "error.apple_signing_key_required",
    savedValue: () => settings.appleWallet.signingKey,
  },
  {
    fromForm: (d) => d.wwdr,
    invalidKey: "error.apple_wwdr_cert_invalid",
    looksValid: isValidCertificate,
    missingKey: "error.apple_wwdr_cert_required",
    savedValue: () => settings.appleWallet.wwdrCert,
  },
] satisfies AppleSecretField[];

/** First problem found across the Apple secret fields, checked in form order.
 * Null when every field passes — the expected outcome for a valid submit. */
const firstAppleSecretProblem =
  (
    d: AppleWalletFormData,
  ): ((
    problemWith: (
      field: AppleSecretField,
      secret: SecretFieldResult,
    ) => string | null | Promise<string | null>,
  ) => Promise<string | null>) =>
  (problemWith) =>
    firstProblem((field: AppleSecretField) =>
      problemWith(field, field.fromForm(d)),
    )(APPLE_SECRET_FIELDS);

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
  log: (d) =>
    isGoogleWalletCleared(d)
      ? t("success.google_wallet_cleared")
      : t("success.google_wallet_updated"),
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
    await saveSecret(d.key, settings.update.googleWallet.serviceAccountKey);
  },
  validate: async (d) => {
    if (isGoogleWalletCleared(d)) return null;
    if (!d.issuerId) return t("error.google_issuer_id_required");
    if (!d.email) return t("error.google_service_email_required");
    if (!settings.googleWallet.hasDbConfig && d.key.action !== "provided") {
      return t("error.google_service_key_required");
    }
    const key = effectiveSecretValue(
      d.key,
      settings.googleWallet.serviceAccountKey,
    );
    if (!(await isValidRsaPrivateKey(key))) {
      return t("error.google_service_key_invalid");
    }
    return null;
  },
});
