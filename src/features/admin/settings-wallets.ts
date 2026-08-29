/**
 * Admin wallet settings routes - Apple Wallet and Google Wallet configuration
 * Owner-only access enforced via settingsHandler
 */

import { isValidRsaPrivateKey } from "#crypto/rsa-private-key.ts";
import { settings } from "#db/settings.ts";
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
import type { RequestRoute } from "#shared/response-steps.ts";

/** One credential on a wallet form: the form field it comes from, the error
 * shown when the operator leaves it blank, and where it is stored. */
type WalletTextField = {
  missingKey: string;
  name: string;
  save: (value: string) => Promise<void>;
};

/** One uploaded secret on a wallet form: a credential that also knows how to
 * read its stored value back, and how to tell it is the right kind of file. */
type WalletSecretField = WalletTextField & {
  invalidKey: string;
  looksValid: (value: string) => boolean | Promise<boolean>;
  savedValue: () => string;
};

/** What one wallet's settings form is, said as data: its fields, its log lines,
 * and whether it already has saved config to fall back on. */
type WalletForm = {
  clearedKey: string;
  formId: string;
  hasSavedConfig: () => boolean;
  secrets: readonly WalletSecretField[];
  texts: readonly WalletTextField[];
  updatedKey: string;
  /** A check no single field can make alone, run last. Apple's signing
   * certificate and key must be a matching pair. */
  pairCheck?: (
    uploadedValue: (field: WalletSecretField) => string,
  ) => Promise<string | null>;
};

/** One submitted wallet form, keyed by form field name. */
type WalletValues = {
  secrets: Record<string, SecretFieldResult>;
  texts: Record<string, string>;
};

/** The uploaded secret, or the saved value when the masked field was kept. */
const effectiveSecretValue = (
  secret: SecretFieldResult,
  saved: string,
): string => (secret.action === "provided" ? secret.value : saved);

/** True when the operator emptied every box, which means "turn this wallet
 * off" rather than "save these details". */
const isAllCleared = (wallet: WalletForm, values: WalletValues): boolean =>
  wallet.texts.every((field) => !values.texts[field.name]) &&
  wallet.secrets.every(
    (field) => values.secrets[field.name]?.action === "cleared",
  );

/** First problem found across the wallet's secrets, checked in form order.
 * Null when every secret passes — the expected outcome for a valid submit. */
const firstSecretProblem =
  (wallet: WalletForm, values: WalletValues) =>
  (
    problemWith: (
      field: WalletSecretField,
      secret: SecretFieldResult,
    ) => string | null | Promise<string | null>,
  ): Promise<string | null> =>
    firstProblem((field: WalletSecretField) =>
      // A field the form always posts, so a missing entry is a wiring bug.
      problemWith(field, values.secrets[field.name] as SecretFieldResult),
    )(wallet.secrets);

const validateWallet = async (
  wallet: WalletForm,
  values: WalletValues,
): Promise<string | null> => {
  if (isAllCleared(wallet, values)) return null;
  const blankText = wallet.texts.find((field) => !values.texts[field.name]);
  if (blankText) return t(blankText.missingKey);
  const checkSecrets = firstSecretProblem(wallet, values);
  if (!wallet.hasSavedConfig()) {
    // No saved config to fall back on, so every secret must be uploaded now.
    const missing = await checkSecrets((field, secret) =>
      secret.action === "provided" ? null : t(field.missingKey),
    );
    if (missing) return missing;
  }
  const invalidSecret = await checkSecrets(async (field, secret) =>
    (await field.looksValid(effectiveSecretValue(secret, field.savedValue())))
      ? null
      : t(field.invalidKey),
  );
  if (invalidSecret) return invalidSecret;
  return wallet.pairCheck
    ? wallet.pairCheck((field) =>
        effectiveSecretValue(
          values.secrets[field.name] as SecretFieldResult,
          field.savedValue(),
        ),
      )
    : null;
};

const saveWallet = async (
  wallet: WalletForm,
  values: WalletValues,
): Promise<void> => {
  if (isAllCleared(wallet, values)) {
    await Promise.all(
      [...wallet.texts, ...wallet.secrets].map((field) => field.save("")),
    );
    return;
  }
  for (const field of wallet.texts) {
    await field.save(values.texts[field.name] as string);
  }
  for (const field of wallet.secrets) {
    await saveSecret(
      values.secrets[field.name] as SecretFieldResult,
      field.save,
    );
  }
};

/** The owner-only POST that saves one wallet's settings. Both wallets are this
 * one handler, told which fields they have. */
const walletSettingsHandler = (wallet: WalletForm): RequestRoute =>
  settingsHandler<WalletValues>({
    advanced: true,
    extract: (form) => ({
      secrets: Object.fromEntries(
        wallet.secrets.map((field) => [
          field.name,
          processSecretField(form, field.name),
        ]),
      ),
      texts: Object.fromEntries(
        wallet.texts.map((field) => [field.name, form.getString(field.name)]),
      ),
    }),
    formId: wallet.formId,
    log: (values) =>
      t(isAllCleared(wallet, values) ? wallet.clearedKey : wallet.updatedKey),
    save: (values) => saveWallet(wallet, values),
    validate: (values) => validateWallet(wallet, values),
  });

/** The three secret uploads on the Apple Wallet form. The signing pair is named
 * because the pair check needs to read both back. */
const APPLE_SIGNING_CERT: WalletSecretField = {
  invalidKey: "error.apple_signing_cert_invalid",
  looksValid: isValidAppleCertificate,
  missingKey: "error.apple_signing_cert_required",
  name: "apple_wallet_signing_cert",
  save: (value) => settings.update.appleWallet.signingCert(value),
  savedValue: () => settings.appleWallet.signingCert,
};

const APPLE_SIGNING_KEY: WalletSecretField = {
  invalidKey: "error.apple_signing_key_invalid",
  looksValid: isValidRsaPrivateKey,
  missingKey: "error.apple_signing_key_required",
  name: "apple_wallet_signing_key",
  save: (value) => settings.update.appleWallet.signingKey(value),
  savedValue: () => settings.appleWallet.signingKey,
};

const APPLE_WWDR_CERT: WalletSecretField = {
  invalidKey: "error.apple_wwdr_cert_invalid",
  looksValid: isValidCertificate,
  missingKey: "error.apple_wwdr_cert_required",
  name: "apple_wallet_wwdr_cert",
  save: (value) => settings.update.appleWallet.wwdrCert(value),
  savedValue: () => settings.appleWallet.wwdrCert,
};

/**
 * Handle POST /admin/settings/apple-wallet - owner only
 */
export const handleAppleWalletPost = walletSettingsHandler({
  clearedKey: "success.apple_wallet_cleared",
  formId: "settings-apple-wallet",
  hasSavedConfig: () => settings.appleWallet.hasDbConfig,
  pairCheck: async (uploadedValue) =>
    (await isValidAppleSigningPair(
      uploadedValue(APPLE_SIGNING_CERT),
      uploadedValue(APPLE_SIGNING_KEY),
    ))
      ? null
      : t("error.apple_signing_pair_mismatch"),
  secrets: [APPLE_SIGNING_CERT, APPLE_SIGNING_KEY, APPLE_WWDR_CERT],
  texts: [
    {
      missingKey: "error.apple_pass_type_id_required",
      name: "apple_wallet_pass_type_id",
      save: (value) => settings.update.appleWallet.passTypeId(value),
    },
    {
      missingKey: "error.apple_team_id_required",
      name: "apple_wallet_team_id",
      save: (value) => settings.update.appleWallet.teamId(value),
    },
  ],
  updatedKey: "success.apple_wallet_updated",
});

/**
 * Handle POST /admin/settings/google-wallet - owner only
 */
export const handleGoogleWalletPost = walletSettingsHandler({
  clearedKey: "success.google_wallet_cleared",
  formId: "settings-google-wallet",
  hasSavedConfig: () => settings.googleWallet.hasDbConfig,
  secrets: [
    {
      invalidKey: "error.google_service_key_invalid",
      looksValid: isValidRsaPrivateKey,
      missingKey: "error.google_service_key_required",
      name: "google_wallet_service_account_key",
      save: (value) => settings.update.googleWallet.serviceAccountKey(value),
      savedValue: () => settings.googleWallet.serviceAccountKey,
    },
  ],
  texts: [
    {
      missingKey: "error.google_issuer_id_required",
      name: "google_wallet_issuer_id",
      save: (value) => settings.update.googleWallet.issuerId(value),
    },
    {
      missingKey: "error.google_service_email_required",
      name: "google_wallet_service_account_email",
      save: (value) => settings.update.googleWallet.serviceAccountEmail(value),
    },
  ],
  updatedKey: "success.google_wallet_updated",
});
