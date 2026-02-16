/**
 * Setup routes - initial system configuration
 */

import { signCsrfToken, verifySignedCsrfToken } from "#lib/csrf.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { settingsApi } from "#lib/db/settings.ts";
import { validateForm } from "#lib/forms.tsx";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  htmlResponse,
  parseFormData,
  redirect,
} from "#routes/utils.ts";
import { setupFields, type SetupFormValues } from "#templates/fields.ts";
import { setupCompletePage, setupPage } from "#templates/setup.tsx";

/** Response helper with signed CSRF token - curried to thread token through */
const setupResponse =
  (token: string) =>
  (error?: string, status = 200) =>
    htmlResponse(setupPage(error, token), status);

/**
 * Validate setup form data (uses form framework + custom validation)
 */
type SetupValidation =
  | {
      valid: true;
      username: string;
      password: string;
      currency: string;
    }
  | { valid: false; error: string };

const validateSetupForm = (form: URLSearchParams): SetupValidation => {
  logDebug("Setup", "Validating form data...");
  logDebug("Setup", `Form keys: ${Array.from(form.keys()).join(", ")}`);

  const validation = validateForm<SetupFormValues>(form, setupFields);
  if (!validation.valid) {
    logDebug("Setup", `Form framework validation failed: ${validation.error}`);
    return validation;
  }

  const { admin_username: username, admin_password: password, admin_password_confirm: passwordConfirm } = validation.values;
  const currency = (validation.values.currency_code || "GBP").toUpperCase();

  // Check Data Controller Agreement acceptance
  const acceptAgreement = form.get("accept_agreement");
  if (acceptAgreement !== "yes") {
    logDebug("Setup", "Agreement not accepted");
    return {
      valid: false,
      error: "You must accept the Data Controller Agreement to continue",
    };
  }

  if (password.length < 8) {
    logDebug("Setup", `Password too short: ${password.length}`);
    return { valid: false, error: "Password must be at least 8 characters" };
  }
  if (password !== passwordConfirm) {
    logDebug("Setup", "Passwords do not match");
    return { valid: false, error: "Passwords do not match" };
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    logDebug("Setup", `Invalid currency code: ${currency}`);
    return { valid: false, error: "Currency code must be 3 uppercase letters" };
  }

  logDebug("Setup", "Validation passed");
  return {
    valid: true,
    username,
    password,
    currency,
  };
};

/**
 * Handle GET /setup/
 */
const handleSetupGet = async (
  isSetupComplete: () => Promise<boolean>,
): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }
  const csrfToken = await signCsrfToken();
  return setupResponse(csrfToken)();
};

/**
 * Handle POST /setup/
 * Validates CSRF token using signed token pattern
 */
const handleSetupPost = async (
  request: Request,
  isSetupComplete: () => Promise<boolean>,
): Promise<Response> => {
  logDebug("Setup", "POST request received");

  if (await isSetupComplete()) {
    logDebug("Setup", "Setup already complete, redirecting");
    return redirect("/");
  }

  // Validate signed CSRF token
  const form = await parseFormData(request);
  const formCsrf = form.get("csrf_token") || "";
  logDebug(
    "Setup",
    `CSRF form present: ${!!formCsrf} length: ${formCsrf.length}`,
  );

  if (!formCsrf || !await verifySignedCsrfToken(formCsrf)) {
    logError({ code: ErrorCode.AUTH_CSRF_MISMATCH, detail: "setup form" });
    const newCsrfToken = await signCsrfToken();
    return setupResponse(newCsrfToken)(
      "Invalid or expired form. Please try again.",
      403,
    );
  }

  logDebug("Setup", "CSRF validation passed, validating form...");

  const validation = validateSetupForm(form);

  if (!validation.valid) {
    logError({ code: ErrorCode.VALIDATION_FORM, detail: "setup" });
    // Keep the same CSRF token for validation errors
    return htmlResponse(setupPage(validation.error, formCsrf), 400);
  }

  logDebug("Setup", "Form validation passed, completing setup...");

  try {
    await settingsApi.completeSetup(
      validation.username,
      validation.password,
      validation.currency,
    );
    await logActivity("Initial setup completed");
    logDebug("Setup", "Setup completed successfully!");
    return redirect("/setup/complete");
  } catch (error) {
    logError({ code: ErrorCode.DB_QUERY, detail: "setup completion" });
    throw error;
  }
};

/**
 * Handle GET /setup/complete - setup success page
 */
const handleSetupComplete = async (
  isSetupComplete: () => Promise<boolean>,
): Promise<Response> => {
  if (!(await isSetupComplete())) {
    return redirect("/setup/");
  }
  return htmlResponse(setupCompletePage());
};

/**
 * Create setup router with injected isSetupComplete dependency
 * Uses factory pattern since setup routes need to check completion status
 */
export const createSetupRouter = (
  isSetupComplete: () => Promise<boolean>,
): ReturnType<typeof createRouter> => {
  const setupRoutes = defineRoutes({
    "GET /setup/complete": () => handleSetupComplete(isSetupComplete),
    "GET /setup": () => handleSetupGet(isSetupComplete),
    "POST /setup": (request) => handleSetupPost(request, isSetupComplete),
  });

  return createRouter(setupRoutes);
};
