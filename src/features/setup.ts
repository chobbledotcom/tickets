/**
 * Setup routes - initial system configuration
 */

import { applyFlash, parseFormData } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { isValidCountry } from "#shared/countries.ts";
import { signCsrfToken, verifySignedCsrfToken } from "#shared/csrf.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateForm } from "#shared/forms.tsx";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { type SetupFormValues, setupFields } from "#templates/fields.ts";
import { setupCompletePage, setupPage } from "#templates/setup.tsx";

/** Response helper - renders setup page with current stored CSRF token */
const setupResponse = (error?: string) => htmlResponse(setupPage(error));

/**
 * Validate setup form data (uses form framework + custom validation)
 */
type SetupValidation =
  | {
      valid: true;
      username: string;
      password: string;
      country: string;
    }
  | { valid: false; error: string };

const validateSetupForm = (form: FormParams): SetupValidation => {
  logDebug("Setup", "Validating form data...");
  logDebug("Setup", `Form keys: ${Array.from(form.keys()).join(", ")}`);

  const validation = validateForm<SetupFormValues>(form, setupFields);
  if (!validation.valid) {
    logDebug("Setup", `Form framework validation failed: ${validation.error}`);
    return validation;
  }

  const {
    admin_username: username,
    admin_password: password,
    admin_password_confirm: passwordConfirm,
  } = validation.values;
  const country = (form.get("country") || "GB").trim().toUpperCase();

  // Check Data Controller Agreement acceptance
  const acceptAgreement = form.get("accept_agreement");
  if (acceptAgreement !== "yes") {
    logDebug("Setup", "Agreement not accepted");
    return {
      error: "You must accept the Data Controller Agreement to continue",
      valid: false,
    };
  }

  if (password.length < 8) {
    logDebug("Setup", `Password too short: ${password.length}`);
    return { error: "Password must be at least 8 characters", valid: false };
  }
  if (password !== passwordConfirm) {
    logDebug("Setup", "Passwords do not match");
    return { error: "Passwords do not match", valid: false };
  }
  if (!isValidCountry(country)) {
    logDebug("Setup", `Invalid country code: ${country}`);
    return { error: "Please select a valid country", valid: false };
  }

  logDebug("Setup", "Validation passed");
  return {
    country,
    password,
    username,
    valid: true,
  };
};

/** Setup completion check callback type */
type SetupCheck = () => Promise<boolean>;

/**
 * Handle GET /setup/
 */
const handleSetupGet = async (
  request: Request,
  isSetupComplete: SetupCheck,
): Promise<Response> => {
  if (await isSetupComplete()) return redirectResponse("/");
  await signCsrfToken();
  const flash = applyFlash(request);
  return setupResponse(flash.error);
};

/**
 * Handle POST /setup/
 * Validates CSRF token using signed token pattern
 */
const handleSetupPost = async (
  request: Request,
  isSetupComplete: SetupCheck,
): Promise<Response> => {
  logDebug("Setup", "POST request received");

  if (await isSetupComplete()) {
    logDebug("Setup", "Setup already complete, redirecting");
    return redirectResponse("/");
  }

  // Validate signed CSRF token
  const form = await parseFormData(request);
  const formCsrf = form.getString("csrf_token");
  logDebug(
    "Setup",
    `CSRF form present: ${!!formCsrf} length: ${formCsrf.length}`,
  );

  if (!formCsrf || !(await verifySignedCsrfToken(formCsrf))) {
    logError({ code: ErrorCode.AUTH_CSRF_MISMATCH, detail: "setup form" });
    return errorRedirect(
      "/setup/",
      "Invalid or expired form. Please try again.",
    );
  }

  logDebug("Setup", "CSRF validation passed, validating form...");

  const validation = validateSetupForm(form);

  if (!validation.valid) {
    logError({ code: ErrorCode.VALIDATION_FORM, detail: "setup" });
    return errorRedirect("/setup/", validation.error);
  }

  logDebug("Setup", "Form validation passed, completing setup...");

  try {
    await settings.setup.complete(
      validation.username,
      validation.password,
      validation.country,
    );
    await logActivity("Initial setup completed");
    logDebug("Setup", "Setup completed successfully!");
    return redirectResponse("/setup/complete");
  } catch (error) {
    logError({ code: ErrorCode.DB_QUERY, detail: "setup completion" });
    throw error;
  }
};

/**
 * Handle GET /setup/complete - setup success page
 */
const handleSetupComplete = async (
  isSetupComplete: SetupCheck,
): Promise<Response> => {
  if (!(await isSetupComplete())) {
    return redirectResponse("/setup/");
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
    "GET /setup": (request) => handleSetupGet(request, isSetupComplete),
    "GET /setup/complete": () => handleSetupComplete(isSetupComplete),
    "POST /setup": (request) => handleSetupPost(request, isSetupComplete),
  });

  return createRouter(setupRoutes);
};
