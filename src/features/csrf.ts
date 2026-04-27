/**
 * Form parsing and CSRF utilities
 */

import { getSearchParam } from "#routes/url.ts";
import {
  CSRF_INVALID_FORM_MESSAGE,
  signCsrfToken,
  verifySignedCsrfToken,
} from "#shared/csrf.ts";
import { getFlash } from "#shared/flash-context.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  setFormError,
  setFormSuccess,
  setSavedFormData,
} from "#shared/forms.tsx";

export { FormParams } from "#shared/form-data.ts";

/**
 * Parse form data from request
 */
export const parseFormData = async (request: Request): Promise<FormParams> => {
  const text = await request.text();
  return new FormParams(text);
};

/**
 * Extract text fields from FormData as FormParams (skips File entries).
 * Handles multi-value fields (e.g. checkbox groups) via append.
 */
export const formDataToParams = (formData: FormData): FormParams => {
  const params = new FormParams();
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") params.append(key, value);
  }
  return params;
};

/** CSRF form result type */
export type CsrfFormResult =
  | { ok: true; form: FormParams }
  | { ok: false; response: Response };

/**
 * Parse form with CSRF validation.
 * Verifies the form token's HMAC signature and expiry.
 * On failure, generates a fresh token (stored for CsrfForm) before calling onInvalid.
 */
export const requireCsrfForm = async (
  request: Request,
  onInvalid: () => Response,
): Promise<CsrfFormResult> => {
  const form = await parseFormData(request);
  const formCsrf = form.getString("csrf_token");

  // Always save form data so validation errors can restore user input.
  // This clears any stale data from a prior request and makes the current
  // submission available to renderFields/getSavedValue during re-rendering.
  setSavedFormData(form);

  if (formCsrf && (await verifySignedCsrfToken(formCsrf))) {
    return { form, ok: true };
  }

  await signCsrfToken();
  return { ok: false, response: onInvalid() };
};

/**
 * Parse a CSRF-protected form, re-rendering the form on invalid CSRF.
 * Centralizes the default invalid/expired message.
 * On failure, generates a fresh token (stored for CsrfForm) and calls onInvalid.
 */
export const withCsrfForm = async (
  request: Request,
  onInvalid: (message: string, status: number) => Response,
  handler: (form: FormParams) => Response | Promise<Response>,
): Promise<Response> => {
  const csrf = await requireCsrfForm(request, () =>
    onInvalid(CSRF_INVALID_FORM_MESSAGE, 403),
  );
  return csrf.ok ? handler(csrf.form) : csrf.response;
};

/**
 * Apply flash message from cookie to form stores for the current request.
 * Call before rendering any page that displays form messages.
 * Reads the flash cookie (set by a previous redirect) and populates the
 * per-request success/error stores so CsrfForm can display them.
 * Returns the flash object for callers that need additional logic.
 */
export const applyFlash = (
  request: Request,
): { success?: string; error?: string; result?: string } => {
  const flash = getFlash();
  const formId = getSearchParam(request, "form");
  if (flash.success) setFormSuccess(formId, flash.success);
  if (flash.error) setFormError(formId, flash.error);
  return flash;
};
