/**
 * Setup routes - initial system configuration
 */

import { completeSetup } from "#lib/db/settings.ts";
import { validateForm } from "#lib/forms.tsx";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  generateSecureToken,
  htmlResponse,
  htmlResponseWithCookie,
  parseCookies,
  parseFormData,
  redirect,
  validateCsrfToken,
} from "#routes/utils.ts";
import { setupFields } from "#templates/fields.ts";
import { setupCompletePage, setupPage } from "#templates/setup.tsx";

/** Cookie for CSRF token with standard security options */
const setupCsrfCookie = (token: string): string =>
  `setup_csrf=${token}; HttpOnly; Secure; SameSite=Strict; Path=/setup; Max-Age=3600`;

/** Response helper with setup CSRF cookie - curried to thread token through */
const setupResponse =
  (token: string) =>
  (error?: string, status = 200) =>
    htmlResponseWithCookie(setupCsrfCookie(token))(
      setupPage(error, token),
      status,
    );

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
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Validating form data...");
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Form keys:", Array.from(form.keys()));

  const validation = validateForm(form, setupFields);
  if (!validation.valid) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] Form framework validation failed:", validation.error);
    return validation;
  }

  const { values } = validation;
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Form values received:", {
    hasPassword: !!values.admin_password,
    passwordLength: (values.admin_password as string)?.length,
    hasConfirm: !!values.admin_password_confirm,
    confirmLength: (values.admin_password_confirm as string)?.length,
    currency: values.currency_code,
    hasStripeKey: !!values.stripe_secret_key,
  });

  const password = values.admin_password as string;
  const passwordConfirm = values.admin_password_confirm as string;
  const currency = ((values.currency_code as string) || "GBP").toUpperCase();

  if (password.length < 8) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] Password too short:", password.length);
    return { valid: false, error: "Password must be at least 8 characters" };
  }
  if (password !== passwordConfirm) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] Passwords do not match");
    return { valid: false, error: "Passwords do not match" };
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] Invalid currency code:", currency);
    return { valid: false, error: "Currency code must be 3 uppercase letters" };
  }

  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Validation passed");
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
const handleSetupGet = async (
  isSetupComplete: () => Promise<boolean>,
): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }
  const csrfToken = generateSecureToken();
  return setupResponse(csrfToken)();
};

/**
 * Handle POST /setup/
 * Validates CSRF token using double-submit cookie pattern
 */
const handleSetupPost = async (
  request: Request,
  isSetupComplete: () => Promise<boolean>,
): Promise<Response> => {
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] POST request received");
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Request URL:", request.url);

  if (await isSetupComplete()) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] Setup already complete, redirecting");
    return redirect("/");
  }

  // Validate CSRF token (double-submit cookie pattern)
  const cookies = parseCookies(request);
  const cookieCsrf = cookies.get("setup_csrf") || "";
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Cookie header:", request.headers.get("cookie"));
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Cookies parsed:", Array.from(cookies.keys()));
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log(
    "[Setup] Cookie CSRF token present:",
    !!cookieCsrf,
    "length:",
    cookieCsrf.length,
  );

  const form = await parseFormData(request);
  const formCsrf = form.get("csrf_token") || "";
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log(
    "[Setup] Form CSRF token present:",
    !!formCsrf,
    "length:",
    formCsrf.length,
  );
  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] CSRF tokens match:", cookieCsrf === formCsrf);

  if (!cookieCsrf || !formCsrf || !validateCsrfToken(cookieCsrf, formCsrf)) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] CSRF validation FAILED");
    const newCsrfToken = generateSecureToken();
    return setupResponse(newCsrfToken)(
      "Invalid or expired form. Please try again.",
      403,
    );
  }

  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] CSRF validation passed, validating form...");

  const validation = validateSetupForm(form);

  if (!validation.valid) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] Form validation FAILED:", validation.error);
    // Keep the same CSRF token for validation errors
    return htmlResponse(setupPage(validation.error, formCsrf), 400);
  }

  // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
  console.log("[Setup] Form validation passed, completing setup...");

  try {
    await completeSetup(
      validation.password,
      validation.stripeKey,
      validation.currency,
    );
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.log("[Setup] Setup completed successfully!");
    return htmlResponse(setupCompletePage());
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: Debug logging for edge script
    console.error("[Setup] Error completing setup:", error);
    throw error;
  }
};

/**
 * Create setup router with injected isSetupComplete dependency
 * Uses factory pattern since setup routes need to check completion status
 */
export const createSetupRouter = (
  isSetupComplete: () => Promise<boolean>,
): ReturnType<typeof createRouter> => {
  const setupRoutes = defineRoutes({
    "GET /setup/": () => handleSetupGet(isSetupComplete),
    "POST /setup/": (request) => handleSetupPost(request, isSetupComplete),
  });

  return createRouter(setupRoutes);
};
