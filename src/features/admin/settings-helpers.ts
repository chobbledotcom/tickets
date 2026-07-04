/**
 * Admin form helpers — composable utilities to reduce boilerplate
 * in admin route handlers that follow the extract → validate → save →
 * logActivity → redirect pattern.
 *
 * The convenience functions (settingsHandler, settingsToggle, etc.)
 * return complete route handlers with auth wrapping baked in.
 * The lower-level composable functions (createSettingsHandler, etc.)
 * return SettingsFormHandler for use with settingsRoute/advancedSettingsRoute.
 */

import {
  type AuthPolicy,
  type AuthSession,
  OWNER_FORM,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, jsonResponse, redirect } from "#routes/response.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { isMaskSentinel, settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { PaymentProviderType } from "#shared/types.ts";

// ── Types ───────────────────────────────────────────────────────────

type ErrorPageFn = (
  error: string,
  status: number,
  formId: string,
) => Response | Promise<Response>;

type SettingsFormHandler = (
  form: FormParams,
  errorPage: ErrorPageFn,
  session: AuthSession,
) => Response | Promise<Response>;

type ValidateFn<T> = (value: T) => string | null | Promise<string | null>;

/** Redirect target: advanced page, custom path, or default settings page.
 * `auth` overrides the form policy (default owner-only) so non-settings pages —
 * e.g. the public-site editor editors share — can widen who may save. */
type RedirectOpts = {
  advanced?: boolean;
  redirectTo?: string;
  auth?: AuthPolicy<"form">;
};

// ── Route wrappers ──────────────────────────────────────────────────

const SETTINGS_PATH = "/admin/settings";
const ADVANCED_PATH = "/admin/settings-advanced";

const pathFor = (opts: RedirectOpts) =>
  opts.redirectTo ?? (opts.advanced ? ADVANCED_PATH : SETTINGS_PATH);

/** Build a route wrapper that provides auth + errorPage for the given path.
 * Defaults to owner-only; pass a wider policy for pages other roles may save. */
const wrapRoute = (path: string, auth: AuthPolicy<"form"> = OWNER_FORM) => {
  const mkErrorPage =
    (_session: AuthSession) =>
    (error: string, _status: number, formId: string): Response =>
      errorRedirect(path, error, formId);
  return (handler: SettingsFormHandler) =>
    (request: Request): Promise<Response> =>
      withAuth(request, auth, (session, form) =>
        handler(form, mkErrorPage(session), session),
      );
};

/** Owner auth form route — errors redirect to /admin/settings */
const settingsRoute = wrapRoute(SETTINGS_PATH);

/** Owner auth form route — errors redirect to /admin/settings-advanced */
const advancedSettingsRoute = wrapRoute(ADVANCED_PATH);

/** Owner auth POST that runs a "test connection" function and returns its
 * result as JSON. Shared by the Stripe/Square/SumUp settings test buttons. */
const testRoute =
  (testFn: () => Promise<unknown>) =>
  (request: Request): Promise<Response> =>
    withAuth(request, OWNER_FORM, async () => jsonResponse(await testFn()));

/** Build the payment webhook URL from the configured domain.
 * Shared by the settings page (display) and the Stripe handler (setup). */
const getWebhookUrl = (): string =>
  `https://${getEffectiveDomain()}/payment/webhook`;

/** Run an optional async validator; return error response or null */
const runValidate = async <T>(
  validate: ValidateFn<T> | undefined,
  value: T,
  errorPage: ErrorPageFn,
  formId: string,
): Promise<Response | null> => {
  if (!validate) return null;
  const error = await validate(value);
  return error ? errorPage(error, 400, formId) : null;
};

/** Wrap a SettingsFormHandler as a complete route handler with auth */
const asRoute = (
  opts: RedirectOpts,
  handler: SettingsFormHandler,
): ((request: Request) => Promise<Response>) =>
  wrapRoute(pathFor(opts), opts.auth)(handler);

// ── Core: createSettingsHandler ─────────────────────────────────────

type SettingsHandlerConfig<T> = RedirectOpts & {
  /** Form ID for flash message targeting (omit for non-settings pages) */
  formId?: string | undefined;
  /** Human-readable label — used for default log (default: "${label} updated") */
  label: string;
  /** Extract the value from form data */
  extract: (form: FormParams) => T;
  /** Validate the value. Return error string or null if valid. */
  validate?: ValidateFn<T> | undefined;
  /** Persist the value */
  save: (value: T) => Promise<void> | void;
  /** Activity log + flash message (default: "${label} updated") */
  log?: (value: T) => string;
};

const createSettingsHandler =
  <T>(cfg: SettingsHandlerConfig<T>): SettingsFormHandler =>
  async (form, errorPage) => {
    const value = cfg.extract(form);
    const invalid = await runValidate(
      cfg.validate,
      value,
      errorPage,
      cfg.formId ?? "",
    );
    if (invalid) return invalid;
    await cfg.save(value);
    const msg = cfg.log ? cfg.log(value) : `${cfg.label} updated`;
    await logActivity(msg);
    return redirect(
      pathFor(cfg),
      msg,
      true,
      cfg.formId ? { formId: cfg.formId } : undefined,
    );
  };

/** Convenience: createSettingsHandler + route wrapping */
const settingsHandler = <T>(
  cfg: SettingsHandlerConfig<T>,
): ((request: Request) => Promise<Response>) =>
  asRoute(cfg, createSettingsHandler(cfg));

// ── Specialization: toggleHandler ───────────────────────────────────

type ToggleConfig = RedirectOpts & {
  formId?: string | undefined;
  field: string;
  label: string;
  save: (value: boolean) => Promise<void> | void;
};

const toggleHandler = (cfg: ToggleConfig): SettingsFormHandler =>
  createSettingsHandler<boolean>({
    ...cfg,
    extract: (form) => form.get(cfg.field) === "true",
    log: (v) => `${cfg.label} ${v ? "enabled" : "disabled"}`,
  });

/** Convenience: toggleHandler + route wrapping */
const settingsToggle = (
  cfg: ToggleConfig,
): ((request: Request) => Promise<Response>) =>
  asRoute(cfg, toggleHandler(cfg));

// ── Shared field config base ─────────────────────────────────────────

type FieldConfig = RedirectOpts & {
  formId?: string | undefined;
  field: string;
  label: string;
  validate?: ValidateFn<string> | undefined;
  save: (value: string) => Promise<void> | void;
};

// ── Specialization: clearableFieldHandler ───────────────────────────

type ClearableFieldConfig = FieldConfig;

const clearableFieldHandler = (
  cfg: ClearableFieldConfig,
): SettingsFormHandler =>
  createSettingsHandler<string>({
    ...cfg,
    extract: (form) => form.getString(cfg.field),
    log: (v) => (v === "" ? `${cfg.label} cleared` : `${cfg.label} updated`),
    validate: (value) => {
      if (value === "") return null;
      return cfg.validate ? cfg.validate(value) : null;
    },
  });

/** Convenience: clearableFieldHandler + route wrapping */
const settingsClearable = (
  cfg: ClearableFieldConfig,
): ((request: Request) => Promise<Response>) =>
  asRoute(cfg, clearableFieldHandler(cfg));

// ── Secret field helpers ────────────────────────────────────────────

/**
 * Result of processing a secret form field.
 * - "unchanged": sentinel detected → keep existing value
 * - "cleared": empty value submitted → caller decides
 * - "provided": new non-empty value submitted → update
 */
type SecretFieldResult =
  | { action: "unchanged" }
  | { action: "cleared" }
  | { action: "provided"; value: string };

/** Extract and classify a secret field from a form submission. */
const processSecretField = (
  form: FormParams,
  fieldName: string,
): SecretFieldResult => {
  const raw = form.getString(fieldName);
  if (isMaskSentinel(raw)) return { action: "unchanged" };
  if (!raw) return { action: "cleared" };
  return { action: "provided", value: raw };
};

type SecretFieldConfig = FieldConfig & {
  required?: boolean;
  afterSave?: (value: string) => Promise<void> | void;
};

const secretFieldHandler =
  (cfg: SecretFieldConfig): SettingsFormHandler =>
  async (form, errorPage) => {
    const field = processSecretField(form, cfg.field);
    const to = pathFor(cfg);
    const fid = cfg.formId ?? "";
    const formOpts = cfg.formId ? { formId: cfg.formId } : undefined;

    if (field.action === "unchanged") {
      return redirect(to, `${cfg.label} unchanged`, true, formOpts);
    }

    if (field.action === "cleared") {
      if (cfg.required) return errorPage(`${cfg.label} is required`, 400, fid);
      return redirect(to, `${cfg.label} cleared`, true, formOpts);
    }

    const invalid = await runValidate(
      cfg.validate,
      field.value,
      errorPage,
      fid,
    );
    if (invalid) return invalid;

    await cfg.save(field.value);
    if (cfg.afterSave) await cfg.afterSave(field.value);
    await logActivity(`${cfg.label} configured`);
    return redirect(to, `${cfg.label} updated successfully`, true, formOpts);
  };

/** Convenience: secretFieldHandler + route wrapping */
const settingsSecret = (
  cfg: SecretFieldConfig,
): ((request: Request) => Promise<Response>) =>
  asRoute(cfg, secretFieldHandler(cfg));

// ── Payment-provider credential routes ──────────────────────────────

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
  /** Persist the secret (only called when a new value was provided). */
  saveSecret: (value: string) => Promise<void> | void;
  /** Persist the non-secret fields (called on every successful save). */
  saveFields?: (fields: T) => Promise<void> | void;
  /** Side effects for a newly provided secret — e.g. Stripe provisions its
   * webhook and persists the returned config. Runs before the secret is saved,
   * so returning an error string aborts the save with nothing persisted. */
  afterSave?: (value: string) => Promise<string | null> | string | null;
  /** Connection-test function behind the sibling `/test` route. */
  testFn: () => Promise<unknown>;
};

/** Persist a validated submission: run `afterSave` + save the secret when a new
 * value was provided, then save the extra fields and select the provider.
 * Returns an `afterSave` error string (nothing persisted) or null on success. */
const persistProviderCredentials = async <T>(
  cfg: ProviderCredentialsConfig<T>,
  fields: T,
  secret: SecretFieldResult,
): Promise<string | null> => {
  if (secret.action === "provided") {
    const error = cfg.afterSave ? await cfg.afterSave(secret.value) : null;
    if (error) return error;
    await cfg.saveSecret(secret.value);
  }
  if (cfg.saveFields) await cfg.saveFields(fields);
  await settings.update.paymentProvider(cfg.provider);
  return null;
};

/**
 * Build the `{ save, test }` route pair for a payment provider's credentials.
 * Stripe passes its webhook provisioning as `afterSave`; the rest differ only
 * in their fields, validation, and persistence.
 */
const defineProviderCredentialsRoute = <T>(
  cfg: ProviderCredentialsConfig<T>,
): {
  save: (request: Request) => Promise<Response>;
  test: (request: Request) => Promise<Response>;
} => {
  const save = settingsRoute(async (form, errorPage) => {
    const secret = processSecretField(form, cfg.secretField);
    const fields = cfg.extraFields
      ? cfg.extraFields(form)
      : (undefined as unknown as T);

    const settingsFlash = (message: string): Response =>
      redirect(SETTINGS_PATH, message, true, { formId: cfg.formId });

    // Provider validation + the "secret required unless already stored" guard.
    const invalid = await cfg.validate(fields, secret);
    if (invalid) return errorPage(invalid, 400, cfg.formId);
    if (secret.action === "cleared" && !cfg.hasSecret()) {
      return errorPage(cfg.secretRequiredError, 400, cfg.formId);
    }

    // A secret-only provider with no new secret is a genuine no-op.
    if (cfg.unchangedMessage && secret.action !== "provided") {
      return settingsFlash(cfg.unchangedMessage);
    }

    const saveError = await persistProviderCredentials(cfg, fields, secret);
    if (saveError) return errorPage(saveError, 400, cfg.formId);

    await logActivity(cfg.logMessage);
    return settingsFlash(cfg.successMessage);
  });

  return { save, test: testRoute(cfg.testFn) };
};

// ── Exports ─────────────────────────────────────────────────────────

export type {
  ClearableFieldConfig,
  ErrorPageFn,
  SecretFieldConfig,
  SecretFieldResult,
  SettingsFormHandler,
  SettingsHandlerConfig,
  ToggleConfig,
};
export {
  advancedSettingsRoute,
  clearableFieldHandler,
  createSettingsHandler,
  defineProviderCredentialsRoute,
  getWebhookUrl,
  processSecretField,
  secretFieldHandler,
  settingsClearable,
  settingsHandler,
  settingsRoute,
  settingsSecret,
  settingsToggle,
  testRoute,
  toggleHandler,
};
