import { redirectResponse } from "#routes/response.ts";
import { settings } from "#shared/db/settings.ts";

/** Run a public-site route only while the Site feature is enabled. */
export const requirePublicSite = <T>(run: () => T): T | Response =>
  settings.features.site ? run() : redirectResponse("/admin/login");
