import { signCsrfToken } from "#shared/csrf.ts";
import {
  clearTestEncryptionKey,
  setupTestEncryptionKey,
} from "#test-utils/env.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

/** Run one test body inside a request context whose CSRF token is signed and
 *  whose encryption key is the test key — for template renders that read the
 *  request-scoped CSRF token while they build a form. */
export const withCsrfRequest = async (
  body: () => void | Promise<void>,
): Promise<void> => {
  setupTestEncryptionKey();
  try {
    await withRequestContext(async () => {
      await signCsrfToken();
      await body();
    });
  } finally {
    clearTestEncryptionKey();
  }
};
