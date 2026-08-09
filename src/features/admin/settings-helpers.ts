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

/* jscpd:ignore-start */
import {
  type AuthPolicy,
  type AuthSession,
  gatedPost,
  OWNER_FORM,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, jsonResponse, redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { isMaskSentinel } from "#shared/db/settings/mask.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { mapValidationError } from "#shared/optional-validate.ts";
import type { RequestRoute, ResponseHandler } from "#shared/response-steps.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/* jscpd:ignore-end */

// ── Types ───────────────────────────────────────────────────────────

type ErrorPageFn = ResponseHandler<[error: string, formId?: string]>;

type SettingsFormHandler = ResponseHandler<
  [form: FormParams, errorPage: ErrorPageFn, session: AuthSession]
>;

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

const pathFor = (opts: RedirectOpts): string => {
  if (typeof opts.redirectTo === "string") return opts.redirectTo;
  return opts.advanced ? ADVANCED_PATH : SETTINGS_PATH;
};

/** Build a route wrapper that provides auth + errorPage for the given path.
 * Defaults to owner-only; pass a wider policy for pages other roles may save. */
const wrapRoute = (path: string, auth: AuthPolicy<"form"> = OWNER_FORM) => {
  const mkErrorPage =
    (_session: AuthSession) =>
    (error: string, formId?: string): Response =>
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
const testRoute = (testFn: () => Promise<unknown>) =>
  gatedPost(OWNER_FORM)(async () => jsonResponse(await testFn()));

/** Run an optional validator, then continue only when it accepts the value. */
const afterValidation = async <T>(
  validate: ValidateFn<T> | undefined,
  value: T,
  errorPage: ErrorPageFn,
  formId: string | undefined,
  onValid: () => Promise<Response>,
): Promise<Response> => {
  const invalid = await mapValidationError(
    validate && (() => validate(value)),
    (error) => errorPage(error, formId),
  );
  if (invalid) return invalid;
  return onValid();
};

/** Wrap a SettingsFormHandler as a complete route handler with auth */
const asRoute = (
  opts: RedirectOpts,
  handler: SettingsFormHandler,
): RequestRoute => wrapRoute(pathFor(opts), opts.auth)(handler);

/** Wrap a "config → handler" builder into its convenience route form: the one
 * config drives both the handler and the auth + redirect wiring. */
const routedSettings =
  <C extends RedirectOpts>(toHandler: (cfg: C) => SettingsFormHandler) =>
  (cfg: C): RequestRoute =>
    asRoute(cfg, toHandler(cfg));

// ── Core: createSettingsHandler ─────────────────────────────────────

type SettingsMessage<T> =
  | { label: string; log?: undefined }
  | { label?: never; log: (value: T) => string };

/** Where the handler's value comes from: a custom `extract` function (with the
 * form field name as optional metadata), or — for a plain string setting —
 * just the field name, which doubles as the extract. */
type SettingsValueSource<T> =
  | {
      /** Extract the value from form data */
      extract: (form: FormParams) => T;
      /** Form field name (metadata only when `extract` is custom) */
      field?: string | undefined;
    }
  | {
      extract?: undefined;
      /** Form field name — also the default extract (`form.getString`) */
      field: [T] extends [string] ? string : never;
    };

type SettingsHandlerConfig<T> = RedirectOpts &
  SettingsMessage<T> &
  SettingsValueSource<T> & {
    /** Form ID for flash message targeting (omit for non-settings pages) */
    formId?: string | undefined;
    /** Validate the value. Return error string or null if valid. */
    validate?: ValidateFn<T> | undefined;
    /** Persist the value */
    save: (value: T) => Promise<void> | void;
    taskName?: string | undefined;
  };

const createSettingsHandler =
  <T = string>(cfg: SettingsHandlerConfig<T>): SettingsFormHandler =>
  async (form, errorPage) => {
    const value =
      cfg.extract !== undefined
        ? cfg.extract(form)
        : // `extract` may only be omitted for a plain string setting that
          // names its `field` (see SettingsValueSource), so the named
          // field's string is the value.
          (form.getString(cfg.field) as T);
    return afterValidation(
      cfg.validate,
      value,
      errorPage,
      cfg.formId,
      async () => {
        if (cfg.taskName) {
          const task = await settings.withCurrentTask(
            cfg.taskName,
            () => Promise.resolve(cfg.save(value)),
            form.getOptionalInt("settings_version"),
          );
          if (!task.ok) return errorPage(task.error, cfg.formId);
        } else await cfg.save(value);
        const msg = cfg.log ? cfg.log(value) : `${cfg.label} updated`;
        await logActivity(msg);
        return redirect(
          pathFor(cfg),
          msg,
          true,
          cfg.formId ? { formId: cfg.formId } : undefined,
        );
      },
    );
  };

/** Convenience: createSettingsHandler + route wrapping */
const settingsHandler = <T = string>(
  cfg: SettingsHandlerConfig<T>,
): RequestRoute => routedSettings(createSettingsHandler<T>)(cfg);

// ── Specialization: toggleHandler ───────────────────────────────────

/** The base every settings field-save config shares: where to redirect, the
 * flash form id, the form field name, its label, and how to persist the value. */
type SavableFieldConfig<T> = RedirectOpts & {
  formId?: string | undefined;
  field: string;
  label: string;
  save: (value: T) => Promise<void> | void;
};

type ToggleConfig = SavableFieldConfig<boolean>;

const toggleHandler = (cfg: ToggleConfig): SettingsFormHandler =>
  createSettingsHandler<boolean>({
    ...withoutLabel(cfg),
    extract: (form) => form.get(cfg.field) === "true",
    log: (v) => `${cfg.label} ${v ? "enabled" : "disabled"}`,
  });

/** Convenience: toggleHandler + route wrapping */
const settingsToggle: (cfg: ToggleConfig) => RequestRoute =
  routedSettings(toggleHandler);

// ── Shared field config base ─────────────────────────────────────────

type FieldConfig = SavableFieldConfig<string> & {
  validate?: ValidateFn<string> | undefined;
};

// ── Specialization: clearableFieldHandler ───────────────────────────

type ClearableFieldConfig = FieldConfig;

const clearableFieldHandler = (
  cfg: ClearableFieldConfig,
): SettingsFormHandler =>
  createSettingsHandler<string>({
    ...withoutLabel(cfg),
    extract: (form) => form.getString(cfg.field),
    log: (v) => (v === "" ? `${cfg.label} cleared` : `${cfg.label} updated`),
    validate: (value) => {
      if (value === "") return null;
      return cfg.validate ? cfg.validate(value) : null;
    },
  });

const withoutLabel = <T extends { label: string }>(
  config: T,
): Omit<T, "label"> => {
  const { label: _, ...rest } = config;
  return rest;
};

/** Convenience: clearableFieldHandler + route wrapping */
const settingsClearable: (cfg: ClearableFieldConfig) => RequestRoute =
  routedSettings(clearableFieldHandler);

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

/**
 * Apply a masked-secret field to its updater.
 * - provided → set the new value
 * - unchanged → leave the stored value as-is
 * - cleared → no-op by default, so blanking a field can't silently wipe a
 *   credential a handler still treats as required (and whose provider stays
 *   selected). Pass `clearable: true` for genuinely optional secrets whose
 *   empty submission should store `""` (e.g. the SMS gateway credentials).
 */
const saveSecret = async (
  field: SecretFieldResult,
  update: (value: string) => Promise<void>,
  opts: { clearable?: boolean } = {},
): Promise<void> => {
  if (field.action === "provided") return update(field.value);
  if (opts.clearable && field.action === "cleared") return update("");
};

type SecretFieldConfig = FieldConfig & {
  formId: string;
};

const secretFieldHandler =
  (cfg: SecretFieldConfig): SettingsFormHandler =>
  async (form, errorPage) => {
    const field = processSecretField(form, cfg.field);
    const to = pathFor(cfg);
    const formOpts = { formId: cfg.formId };

    if (field.action === "unchanged") {
      return redirect(to, `${cfg.label} unchanged`, true, formOpts);
    }

    if (field.action === "cleared") {
      return errorPage(`${cfg.label} is required`, cfg.formId);
    }

    return afterValidation(
      cfg.validate,
      field.value,
      errorPage,
      cfg.formId,
      async () => {
        await cfg.save(field.value);
        await logActivity(`${cfg.label} configured`);
        return redirect(
          to,
          `${cfg.label} updated successfully`,
          true,
          formOpts,
        );
      },
    );
  };

/** Convenience: secretFieldHandler + route wrapping */
const settingsSecret: (cfg: SecretFieldConfig) => RequestRoute =
  routedSettings(secretFieldHandler);

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
const defineProviderCredentialsRoute = <T>(
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
  processSecretField,
  saveSecret,
  secretFieldHandler,
  settingsClearable,
  settingsHandler,
  settingsRoute,
  settingsSecret,
  settingsToggle,
  testRoute,
  toggleHandler,
};
