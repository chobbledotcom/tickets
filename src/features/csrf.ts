/**
 * Form parsing and CSRF utilities
 */

import { errorRedirect } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import {
  csrfInvalidFormMessage,
  signCsrfToken,
  verifySignedCsrfToken,
} from "#shared/csrf.ts";
import { type Flash, getFlash, setFlashFormId } from "#shared/flash-context.ts";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms.tsx";
import { validateMessageText } from "#shared/inbound-message.ts";

export { FormParams } from "#shared/form-data.ts";

/**
 * Read and validate the shared "message" field of a contact/support form.
 * Returns the message text, or an error redirect to `path` when it is missing
 * or too long. The `string | Response` shape mirrors the session guards, so a
 * caller writes `if (x instanceof Response) return x;`.
 */
export const requireMessageField = (
  form: FormParams,
  path: string,
): string | Response => {
  const message = form.getString("message");
  const error = validateMessageText(message);
  return error ? errorRedirect(path, error) : message;
};

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
    onInvalid(csrfInvalidFormMessage(), 403),
  );
  return csrf.ok ? handler(csrf.form) : csrf.response;
};

/**
 * Record the form a redirect targeted (`?form=`) so a matching CsrfForm renders
 * the flash inline, and return the flash for callers that need it. The flash
 * itself is already in the request context (set by middleware) and is rendered
 * by the Layout backstop or the targeted form — handlers no longer thread it.
 */
export const applyFlash = (request: Request): Flash => {
  setFlashFormId(getSearchParam(request, "form"));
  return getFlash();
};
