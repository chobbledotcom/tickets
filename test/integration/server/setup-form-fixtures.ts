/**
 * Setup-form fixtures shared by the setup suites: read the CSRF token off the
 * setup page and submit the form with standard valid credentials.
 */
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { extractCsrfToken } from "#test-utils/csrf.ts";
import { TEST_ADMIN_USERNAME } from "#test-utils/internal.ts";
import { mockRequest, mockSetupFormRequest } from "#test-utils/mocks.ts";

/** Get CSRF token from setup page and submit setup form with given fields */
export async function submitSetupForm(
  fields: Record<string, string>,
): Promise<Response> {
  const getResponse = await handleRequest(mockRequest("/setup/"));
  const csrfToken = extractCsrfToken(await getResponse.text());
  expect(csrfToken).not.toBeNull();
  return handleRequest(mockSetupFormRequest(fields, csrfToken as string));
}

/** Get CSRF token from setup page and submit with standard valid credentials + overrides */
export function submitSetupFormWithDefaults(
  overrides: Record<string, string> = {},
): Promise<Response> {
  return submitSetupForm({
    admin_password: "mypassword123",
    admin_password_confirm: "mypassword123",
    admin_username: TEST_ADMIN_USERNAME,
    country: "GB",
    ...overrides,
  });
}
