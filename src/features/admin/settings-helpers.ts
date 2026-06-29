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
import { isMaskSentinel } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";

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
  formId?: string;
  /** Human-readable label — used for default log (default: "${label} updated") */
  label: string;
  /** Extract the value from form data */
  extract: (form: FormParams) => T;
  /** Validate the value. Return error string or null if valid. */
  validate?: ValidateFn<T>;
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
  formId?: string;
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
  formId?: string;
  field: string;
  label: string;
  validate?: ValidateFn<string>;
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
