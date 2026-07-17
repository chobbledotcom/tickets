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
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import { validateMessageText } from "#shared/inbound-message.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";

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

/** Parse a submitted form and pull out its CSRF token field in one step. */
export const parseFormWithCsrf = async (
  request: Request,
): Promise<{ form: FormParams; formCsrf: string }> => {
  const form = await parseFormData(request);
  return { form, formCsrf: form.getString("csrf_token") };
};

/**
 * Read a required uploaded file from a multipart form. Returns the file, or the
 * caller's error response when the field is missing or empty.
 */
export const requireUploadedFile = (
  formData: FormData,
  field: string,
  onMissing: () => Response,
): File | Response => {
  const file = formData.get(field);
  return file instanceof File && file.size > 0 ? file : onMissing();
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
  const { form, formCsrf } = await parseFormWithCsrf(request);

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
  handler: ResponseHandler<[form: FormParams]>,
): Promise<Response> => {
  const csrf = await requireCsrfFormWithMessage(request, (message) =>
    onInvalid(message, 403),
  );
  return csrf.ok ? handler(csrf.form) : csrf.response;
};

/**
 * Parse a CSRF form, building the failure response from the standard
 * invalid/expired token message. The message-to-Response step stays the
 * caller's, so each surface can pick its own status and shape.
 */
export const requireCsrfFormWithMessage = (
  request: Request,
  onInvalid: (message: string) => Response,
): Promise<CsrfFormResult> =>
  requireCsrfForm(request, () => onInvalid(csrfInvalidFormMessage()));

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
