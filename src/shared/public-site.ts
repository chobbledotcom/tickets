import { settings } from "#db/settings.ts";
import { redirectResponse } from "#routes/response.ts";

/** Run a public-site route only while the Site feature is enabled. */
export const requirePublicSite = <T>(run: () => T): T | Response =>
  settings.features.site ? run() : redirectResponse("/admin/login");
