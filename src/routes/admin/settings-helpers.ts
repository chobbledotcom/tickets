/**
 * Settings form helpers — composable utilities to reduce boilerplate
 * in admin settings route handlers.
 *
 * Most settings POST handlers follow the same pattern:
 *   extract value → validate → save → logActivity → redirect
 *
 * The convenience functions (settingsHandler, settingsToggle, etc.)
 * return complete route handlers with auth wrapping baked in.
 * The lower-level composable functions (createSettingsHandler, etc.)
 * return SettingsFormHandler for use with settingsRoute/advancedSettingsRoute.
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { isMaskSentinel } from "#lib/db/settings.ts";
import type { FormParams } from "#lib/form-data.ts";
import {
  type AuthSession,
  errorRedirect,
  OWNER_FORM,
  redirect,
  withAuth,
} from "#routes/utils.ts";

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

// ── Route wrappers ──────────────────────────────────────────────────

const SETTINGS_PATH = "/admin/settings";
const ADVANCED_PATH = "/admin/settings-advanced";

const errorPageFor =
  (basePath: string) =>
  (_session: AuthSession) =>
  (error: string, _status: number, formId: string): Response =>
    errorRedirect(basePath, error, formId);

const settingsPageWithError = errorPageFor(SETTINGS_PATH);
const advancedSettingsPageWithError = errorPageFor(ADVANCED_PATH);

/** Owner auth form route — errors redirect to /admin/settings */
const settingsRoute =
  (handler: SettingsFormHandler) =>
  (request: Request): Promise<Response> =>
    withAuth(request, OWNER_FORM, (session, form) =>
      handler(form, settingsPageWithError(session), session),
    );

/** Owner auth form route — errors redirect to /admin/settings-advanced */
const advancedSettingsRoute =
  (handler: SettingsFormHandler) =>
  (request: Request): Promise<Response> =>
    withAuth(request, OWNER_FORM, (session, form) =>
      handler(form, advancedSettingsPageWithError(session), session),
    );

/** Pick route wrapper based on `advanced` flag */
const routeFor = (advanced?: boolean) =>
  advanced ? advancedSettingsRoute : settingsRoute;

/** Pick redirect path based on `advanced` flag */
const pathFor = (advanced?: boolean) =>
  advanced ? ADVANCED_PATH : SETTINGS_PATH;

// ── Core: createSettingsHandler ─────────────────────────────────────

type SettingsHandlerConfig<T> = {
  /** Form ID for flash message targeting */
  formId: string;
  /** Human-readable label — used for default log/message */
  label: string;
  /** If true, redirect to /admin/settings-advanced instead of /admin/settings */
  advanced?: boolean;
  /** Extract the value from form data */
  extract: (form: FormParams) => T;
  /** Validate the value. Return error string or null if valid. */
  validate?: (value: T) => string | null;
  /** Persist the value */
  save: (value: T) => Promise<void> | void;
  /** Activity log message (default: "${label} updated") */
  log?: (value: T) => string;
  /** Flash success message (default: same as log) */
  message?: (value: T) => string;
};

const createSettingsHandler =
  <T>(cfg: SettingsHandlerConfig<T>): SettingsFormHandler =>
  async (form, errorPage) => {
    const value = cfg.extract(form);
    if (cfg.validate) {
      const error = cfg.validate(value);
      if (error) return errorPage(error, 400, cfg.formId);
    }
    await cfg.save(value);
    const logMsg = cfg.log ? cfg.log(value) : `${cfg.label} updated`;
    await logActivity(logMsg);
    const flashMsg = cfg.message ? cfg.message(value) : logMsg;
    return redirect(pathFor(cfg.advanced), flashMsg, true, {
      formId: cfg.formId,
    });
  };

/** Convenience: createSettingsHandler + route wrapping */
const settingsHandler = <T>(
  cfg: SettingsHandlerConfig<T>,
): ((request: Request) => Promise<Response>) =>
  routeFor(cfg.advanced)(createSettingsHandler(cfg));

// ── Specialization: toggleHandler ───────────────────────────────────

type ToggleConfig = {
  formId: string;
  /** Form field name */
  field: string;
  /** Human-readable label (e.g. "Public site") */
  label: string;
  /** Persist the boolean value */
  save: (value: boolean) => Promise<void> | void;
  /** If true, redirect to /admin/settings-advanced */
  advanced?: boolean;
};

const toggleHandler = (cfg: ToggleConfig): SettingsFormHandler =>
  createSettingsHandler<boolean>({
    formId: cfg.formId,
    label: cfg.label,
    advanced: cfg.advanced,
    extract: (form) => form.get(cfg.field) === "true",
    save: cfg.save,
    log: (v) => `${cfg.label} ${v ? "enabled" : "disabled"}`,
    message: (v) => `${cfg.label} ${v ? "enabled" : "disabled"}`,
  });

/** Convenience: toggleHandler + route wrapping */
const settingsToggle = (
  cfg: ToggleConfig,
): ((request: Request) => Promise<Response>) =>
  routeFor(cfg.advanced)(toggleHandler(cfg));

// ── Specialization: clearableFieldHandler ───────────────────────────

type ClearableFieldConfig = {
  formId: string;
  /** Form field name */
  field: string;
  /** Human-readable label (e.g. "Business email") */
  label: string;
  /** Validate non-empty values. Return error string or null. */
  validate?: (value: string) => string | null;
  /** Persist the value (called for both set and clear) */
  save: (value: string) => Promise<void> | void;
  /** If true, redirect to /admin/settings-advanced */
  advanced?: boolean;
};

const clearableFieldHandler = (
  cfg: ClearableFieldConfig,
): SettingsFormHandler =>
  createSettingsHandler<string>({
    formId: cfg.formId,
    label: cfg.label,
    advanced: cfg.advanced,
    extract: (form) => form.getString(cfg.field),
    validate: (value) => {
      if (value === "") return null;
      return cfg.validate ? cfg.validate(value) : null;
    },
    save: cfg.save,
    log: (v) => (v === "" ? `${cfg.label} cleared` : `${cfg.label} updated`),
    message: (v) =>
      v === "" ? `${cfg.label} cleared` : `${cfg.label} updated`,
  });

/** Convenience: clearableFieldHandler + route wrapping */
const settingsClearable = (
  cfg: ClearableFieldConfig,
): ((request: Request) => Promise<Response>) =>
  routeFor(cfg.advanced)(clearableFieldHandler(cfg));

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

type SecretFieldConfig = {
  formId: string;
  /** Form field name */
  field: string;
  /** Human-readable label */
  label: string;
  /** If true, "cleared" returns an error. If false, "cleared" is allowed. */
  required?: boolean;
  /** Validate the provided value. Return error string or null. */
  validate?: (value: string) => string | null;
  /** Persist the value (only called for "provided" action) */
  save: (value: string) => Promise<void> | void;
  /** Additional saves to run after the main save */
  afterSave?: (value: string) => Promise<void> | void;
  /** If true, redirect to /admin/settings-advanced */
  advanced?: boolean;
};

const secretFieldHandler =
  (cfg: SecretFieldConfig): SettingsFormHandler =>
  async (form, errorPage) => {
    const field = processSecretField(form, cfg.field);
    const to = pathFor(cfg.advanced);

    if (field.action === "unchanged") {
      return redirect(to, `${cfg.label} unchanged`, true, {
        formId: cfg.formId,
      });
    }

    if (field.action === "cleared") {
      if (cfg.required) {
        return errorPage(`${cfg.label} is required`, 400, cfg.formId);
      }
      return redirect(to, `${cfg.label} cleared`, true, {
        formId: cfg.formId,
      });
    }

    if (cfg.validate) {
      const error = cfg.validate(field.value);
      if (error) return errorPage(error, 400, cfg.formId);
    }

    await cfg.save(field.value);
    if (cfg.afterSave) await cfg.afterSave(field.value);
    await logActivity(`${cfg.label} configured`);
    return redirect(to, `${cfg.label} updated successfully`, true, {
      formId: cfg.formId,
    });
  };

/** Convenience: secretFieldHandler + route wrapping */
const settingsSecret = (
  cfg: SecretFieldConfig,
): ((request: Request) => Promise<Response>) =>
  routeFor(cfg.advanced)(secretFieldHandler(cfg));

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
  processSecretField,
  secretFieldHandler,
  settingsClearable,
  settingsHandler,
  settingsRoute,
  settingsSecret,
  settingsToggle,
  toggleHandler,
};
