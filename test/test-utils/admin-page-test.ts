import { signCsrfToken } from "#shared/csrf.ts";
import type { AdminSession } from "#shared/types.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

/** Owner session for tests that render an admin page template directly. */
export const OWNER_SESSION: AdminSession = { adminLevel: "owner" };

/** Prime the test encryption key and sign a CSRF token — the setup every
 *  admin page template test needs before it renders a page. Pass this to
 *  `beforeAll` from each test file's own suite; a shared helper must not
 *  register the hook itself (`scripts/test-groups.ts` rejects that). */
export const setupAdminPageTest = async (): Promise<void> => {
  setupTestEncryptionKey();
  await signCsrfToken();
};
