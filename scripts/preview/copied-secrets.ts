// effects: pure
/** The secrets a preview site copies from the build environment. */

import { errorResult, okResult, type Result } from "#shared/result.ts";

/** `site` is the secret name on the preview script. `env` is the variable that
 * holds its value in the build environment. The staging storage zone replaces
 * the real one. The host mail keys are the real ones, so a preview sends real
 * mail. */
/* jscpd:ignore-start -- static data, not code */
const COPIED_SECRETS = [
  { env: "STAGING_STORAGE_ZONE_NAME", site: "STORAGE_ZONE_NAME" },
  { env: "STAGING_STORAGE_ZONE_KEY", site: "STORAGE_ZONE_KEY" },
  { env: "HOST_EMAIL_PROVIDER", site: "HOST_EMAIL_PROVIDER" },
  { env: "HOST_EMAIL_API_KEY", site: "HOST_EMAIL_API_KEY" },
  { env: "HOST_EMAIL_FROM_ADDRESS", site: "HOST_EMAIL_FROM_ADDRESS" },
] as const;
/* jscpd:ignore-end */

/** Each copied secret as [site name, value]. A missing or blank variable fails
 * the run, and the message names every one that is missing. */
export const readCopiedSecrets = (
  getEnv: (key: string) => string | undefined,
): Result<[string, string][]> => {
  const values = COPIED_SECRETS.map(({ env, site }) => ({
    env,
    site,
    value: getEnv(env)?.trim() ?? "",
  }));
  const missing = values.filter(({ value }) => value === "");
  if (missing.length > 0) {
    return errorResult(
      `Set these secrets for the preview: ${missing.map(({ env }) => env).join(", ")}.`,
    );
  }
  return okResult(values.map(({ site, value }) => [site, value]));
};
