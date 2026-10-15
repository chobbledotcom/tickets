/**
 * Admin-email env fixtures for the superuser settings suite: scope the
 * ADMIN_EMAIL_ADDRESS override, and pre-enable the host email provider so a
 * superuser enable can send its credentials mail.
 */
import { lazyRef } from "#fp";
import { hostEmail } from "#shared/email.ts";
import { validEmail } from "#test-utils/email.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";

const [getAdminEmailEnv, setAdminEmailEnv] = lazyRef<EnvScope | null>(
  () => null,
);

export const clearAdminEmailEnv = (): void => {
  getAdminEmailEnv()?.dispose();
  setAdminEmailEnv(null);
};

export function restoreAdminEmail(value: string | undefined): void {
  clearAdminEmailEnv();
  setAdminEmailEnv(withEnv({ ADMIN_EMAIL_ADDRESS: value }));
}

export function setupForEnable(email: string): void {
  restoreAdminEmail(email);
  hostEmail.setOverride({
    apiKey: "k",
    fromAddress: validEmail("f@e.com"),
    provider: "resend",
  });
}
