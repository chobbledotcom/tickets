import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import {
  expectErrorFlash,
  expectFlash,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";

/** POST one settings form with a fresh CSRF token and the owner cookie. */
export const postSettingsForm = async (
  path: string,
  fields: Record<string, string>,
): Promise<Response> => {
  const csrfToken = await testCsrfToken();
  return handleRequest(
    mockFormRequest(path, { csrfToken, ...fields }, await testCookie()),
  );
};

/** Assert a settings POST redirected with the named success flash. */
export const expectSettingsSaved = (
  response: Response,
  message: string,
): void => {
  expect(response.status).toBe(302);
  expectFlash(response, message);
};

/** Assert a settings POST redirected with an error flash containing `text`. */
export const expectSettingsRefused = (
  response: Response,
  text: string,
): void => {
  expectErrorFlash(response, text);
};

/** Assert an admin page answers 200 and carries each fragment. */
export const expectAdminPage = async (
  path: string,
  fragments: string[],
): Promise<void> => {
  const response = await adminGet(path);
  expect(response.status).toBe(200);
  expectIncludesAll(await response.text(), fragments);
};
