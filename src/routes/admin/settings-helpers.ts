/**
 * Settings form helpers — composable utilities to reduce boilerplate
 * in admin settings route handlers.
 *
 * Most settings POST handlers follow the same pattern:
 *   extract value → validate → save → logActivity → redirect
 *
 * By expressing each handler as a config object, we eliminate the
 * repetitive redirect/errorPage/logActivity wiring and let each
 * handler focus on what's unique: its validation and save logic.
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { isMaskSentinel } from "#lib/db/settings.ts";
import type { FormParams } from "#lib/form-data.ts";
import { redirect } from "#routes/utils.ts";

// ── Types ───────────────────────────────────────────────────────────

type ErrorPageFn = (
  error: string,
  status: number,
  formId: string,
) => Response | Promise<Response>;

type SettingsFormHandler = (
  form: FormParams,
  errorPage: ErrorPageFn,
  session: unknown,
) => Response | Promise<Response>;

// ── Core: createSettingsHandler ─────────────────────────────────────

type SettingsHandlerConfig<T> = {
  /** Form ID for flash message targeting */
  formId: string;
  /** Redirect target after success (default: "/admin/settings") */
  redirectTo?: string;
  /** Extract the value from form data */
  extract: (form: FormParams) => T;
  /** Validate the value. Return error string or null if valid. */
  validate?: (value: T) => string | null;
  /** Persist the value */
  save: (value: T) => Promise<void> | void;
  /** Activity log message */
  log: (value: T) => string;
  /** Flash success message */
  message: (value: T) => string;
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
    await logActivity(cfg.log(value));
    return redirect(
      cfg.redirectTo ?? "/admin/settings",
      cfg.message(value),
      true,
      {
        formId: cfg.formId,
      },
    );
  };

// ── Specialization: toggleHandler ───────────────────────────────────

type ToggleConfig = {
  formId: string;
  /** Form field name */
  field: string;
  /** Human-readable label (e.g. "Public site") */
  label: string;
  /** Persist the boolean value */
  save: (value: boolean) => Promise<void> | void;
  /** Redirect target (default: "/admin/settings") */
  redirectTo?: string;
};

const toggleHandler = (cfg: ToggleConfig): SettingsFormHandler =>
  createSettingsHandler<boolean>({
    formId: cfg.formId,
    redirectTo: cfg.redirectTo,
    extract: (form) => form.get(cfg.field) === "true",
    save: cfg.save,
    log: (v) => `${cfg.label} ${v ? "enabled" : "disabled"}`,
    message: (v) => `${cfg.label} ${v ? "enabled" : "disabled"}`,
  });

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
  /** Redirect target (default: "/admin/settings") */
  redirectTo?: string;
};

const clearableFieldHandler = (
  cfg: ClearableFieldConfig,
): SettingsFormHandler =>
  createSettingsHandler<string>({
    formId: cfg.formId,
    redirectTo: cfg.redirectTo,
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
  /** Redirect target (default: "/admin/settings") */
  redirectTo?: string;
};

const secretFieldHandler =
  (cfg: SecretFieldConfig): SettingsFormHandler =>
  async (form, errorPage) => {
    const field = processSecretField(form, cfg.field);
    const to = cfg.redirectTo ?? "/admin/settings";

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
  clearableFieldHandler,
  createSettingsHandler,
  processSecretField,
  secretFieldHandler,
  toggleHandler,
};
