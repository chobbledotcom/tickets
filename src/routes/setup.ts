/**
 * Setup routes - initial system configuration
 */

import { completeSetup } from "#lib/db.ts";
import { validateForm } from "#lib/forms.ts";
import { setupCompletePage, setupFields, setupPage } from "#templates";
import {
  generateSecureToken,
  htmlResponse,
  parseCookies,
  parseFormData,
  redirect,
  validateCsrfToken,
} from "./utils.ts";

/**
 * Validate setup form data (uses form framework + custom validation)
 */
type SetupValidation =
  | {
      valid: true;
      password: string;
      stripeKey: string | null;
      currency: string;
    }
  | { valid: false; error: string };

const validateSetupForm = (form: URLSearchParams): SetupValidation => {
  const validation = validateForm(form, setupFields);
  if (!validation.valid) {
    return validation;
  }

  const { values } = validation;
  const password = values.admin_password as string;
  const passwordConfirm = values.admin_password_confirm as string;
  const currency = ((values.currency_code as string) || "GBP").toUpperCase();

  if (password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters" };
  }
  if (password !== passwordConfirm) {
    return { valid: false, error: "Passwords do not match" };
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { valid: false, error: "Currency code must be 3 uppercase letters" };
  }

  return {
    valid: true,
    password,
    stripeKey: (values.stripe_secret_key as string | null) || null,
    currency,
  };
};

/**
 * Handle GET /setup/
 * Uses double-submit cookie pattern for CSRF protection
 */
export const handleSetupGet = async (
  isSetupComplete: () => Promise<boolean>,
): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }
  const csrfToken = generateSecureToken();
  const response = htmlResponse(setupPage(undefined, csrfToken));
  const headers = new Headers(response.headers);
  headers.set(
    "set-cookie",
    `setup_csrf=${csrfToken}; HttpOnly; Secure; SameSite=Strict; Path=/setup/; Max-Age=3600`,
  );
  return new Response(response.body, {
    status: response.status,
    headers,
  });
};

/**
 * Handle POST /setup/
 * Validates CSRF token using double-submit cookie pattern
 */
export const handleSetupPost = async (
  request: Request,
  isSetupComplete: () => Promise<boolean>,
): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }

  // Validate CSRF token (double-submit cookie pattern)
  const cookies = parseCookies(request);
  const cookieCsrf = cookies.get("setup_csrf") || "";
  const form = await parseFormData(request);
  const formCsrf = form.get("csrf_token") || "";

  if (!cookieCsrf || !formCsrf || !validateCsrfToken(cookieCsrf, formCsrf)) {
    // Generate new token for retry
    const newCsrfToken = generateSecureToken();
    const response = htmlResponse(
      setupPage("Invalid or expired form. Please try again.", newCsrfToken),
      403,
    );
    const headers = new Headers(response.headers);
    headers.set(
      "set-cookie",
      `setup_csrf=${newCsrfToken}; HttpOnly; Secure; SameSite=Strict; Path=/setup/; Max-Age=3600`,
    );
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  const validation = validateSetupForm(form);

  if (!validation.valid) {
    // Keep the same CSRF token for validation errors
    return htmlResponse(setupPage(validation.error, formCsrf), 400);
  }

  await completeSetup(
    validation.password,
    validation.stripeKey,
    validation.currency,
  );
  return htmlResponse(setupCompletePage());
};

/**
 * Check if path is setup route
 */
const isSetupPath = (path: string): boolean =>
  path === "/setup/" || path === "/setup";

/**
 * Route setup requests
 */
export const routeSetup = async (
  request: Request,
  path: string,
  method: string,
  isSetupComplete: () => Promise<boolean>,
): Promise<Response | null> => {
  if (!isSetupPath(path)) return null;

  if (method === "GET") {
    return handleSetupGet(isSetupComplete);
  }
  if (method === "POST") {
    return handleSetupPost(request, isSetupComplete);
  }
  return null;
};
