/**
 * Payment-provider credential routes — the `{ save, test }` route pair
 * behind the Stripe/Square/SumUp settings forms.
 */

import { logActivity } from "#db/activity-log.ts";
import { settings } from "#db/settings.ts";
import {
  processSecretField,
  SETTINGS_PATH,
  type SecretFieldResult,
  settingsRoute,
  testRoute,
} from "#routes/admin/settings-helpers.ts";
import { redirect } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { PaymentProviderType } from "#types";

/**
 * Config for a payment provider's credential-save route. Collapses the shape
 * shared by Stripe/Square/SumUp: extract a masked secret (+ optional text
 * fields) → validate → "secret required unless already stored" → persist
 * credentials → select the provider → sibling test route.
 */
type ProviderCredentialsConfig<T> = {
  /** Provider selected on a successful save. */
  provider: PaymentProviderType;
  /** Form ID for flash-message targeting. */
  formId: string;
  /** Form field name of the masked secret. */
  secretField: string;
  /** Whether a secret is already stored (drives the "required" guard). */
  hasSecret: () => boolean;
  /** Error shown when the secret is cleared and none is stored. */
  secretRequiredError: string;
  /** Flash message + activity-log entry on a successful save. */
  successMessage: string;
  logMessage: string;
  /** Flash for a secret-only provider (no extra fields) when the submission
   * carries no new secret — a genuine no-op. Set only by such providers;
   * providers with extra fields always persist and never go "unchanged". */
  unchangedMessage?: string;
  /** Extract the non-secret fields (location, merchant code, …). */
  extraFields?: (form: FormParams) => T;
  /** Provider-specific validation (demo-mode guard, field/format checks).
   * Receives the extra fields and the classified secret. Every provider has at
   * least a demo-mode guard, so this is required. */
  validate: (
    fields: T,
    secret: SecretFieldResult,
  ) => string | null | Promise<string | null>;
  /** Persist a newly provided secret and run any provider setup it needs.
   * Return an error string when an expected setup failure should be shown on
   * the form. Thrown failures propagate. */
  saveSecret: (
    value: string,
    activateFromMissing: boolean,
  ) => Promise<string | null> | Promise<void>;
  /** Persist the non-secret fields (called on every successful save). */
  saveFields?: (fields: T) => Promise<void> | void;
  /** Connection-test function behind the sibling `/test` route. */
  testFn: () => Promise<unknown>;
};

/** Persist a validated submission without switching sales back on. */
const persistProviderCredentials = async <T>(
  cfg: ProviderCredentialsConfig<T>,
  fields: T,
  secret: SecretFieldResult,
  activateFromMissing: boolean,
): Promise<string | null> => {
  if (secret.action === "provided") {
    const error = await cfg.saveSecret(secret.value, activateFromMissing);
    if (error) return error;
  }
  if (cfg.saveFields) await cfg.saveFields(fields);
  await settings.update.paymentProviderAfterCredentialSave(
    cfg.provider,
    activateFromMissing,
  );
  return null;
};

/**
 * Build the `{ save, test }` route pair for a payment provider's credentials.
 * Stripe includes webhook provisioning in its secret save; the rest differ
 * only in their fields, validation, and persistence.
 */
export const defineProviderCredentialsRoute = <T>(
  cfg: ProviderCredentialsConfig<T>,
): {
  save: (request: Request) => Promise<Response>;
  test: (request: Request) => Promise<Response>;
} => {
  const save = settingsRoute(async (form, errorPage) => {
    const activateFromMissing = !cfg.hasSecret();
    const secret = processSecretField(form, cfg.secretField);
    const fields = cfg.extraFields
      ? cfg.extraFields(form)
      : (undefined as unknown as T);

    const settingsFlash = (message: string): Response =>
      redirect(SETTINGS_PATH, message, true, { formId: cfg.formId });

    // Provider validation + the "secret required unless already stored" guard.
    const invalid = await cfg.validate(fields, secret);
    if (invalid) return errorPage(invalid, cfg.formId);
    if (secret.action === "cleared" && !cfg.hasSecret()) {
      return errorPage(cfg.secretRequiredError, cfg.formId);
    }

    // A secret-only provider with no new secret is a genuine no-op.
    if (cfg.unchangedMessage && secret.action !== "provided") {
      return settingsFlash(cfg.unchangedMessage);
    }

    const task = await settings.withCurrentTask(
      `payment-provider-${cfg.provider}`,
      async () => {
        const saveError = await persistProviderCredentials(
          cfg,
          fields,
          secret,
          activateFromMissing,
        );
        if (saveError) return errorPage(saveError, cfg.formId);
        await logActivity(cfg.logMessage);
        return settingsFlash(cfg.successMessage);
      },
      form.getOptionalInt("settings_version"),
    );
    return task.ok ? task.value : errorPage(task.error, cfg.formId);
  });

  return { save, test: testRoute(cfg.testFn) };
};
