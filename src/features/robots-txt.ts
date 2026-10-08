/** The robots.txt body, read from the site's own state.
 *
 *  The public site feature decides which pages a crawler can read. While it
 *  is off, only the listings pages are open. Once it is on, every page the
 *  site serves is open. The private areas lean on their noindex headers and
 *  their auth. The file names no path for a crawler to probe. */

import { isMissingSettingsTableError } from "#db/migrations/errors.ts";
import { settings } from "#db/settings.ts";
import { encodeBody } from "#routes/response.ts";
import { TEXT } from "#shared/content-types.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const PRIVATE_ROBOTS_TXT = "User-agent: *\nAllow: /listings/\nDisallow: /\n";

const PUBLIC_ROBOTS_TXT = "User-agent: *\nAllow: /\n";

/** Serve robots.txt from the site's own state. The static path serves before
 *  the request's settings load, so the body decision loads its own key: both
 *  fresh and declared. The cache is short, because the body follows a
 *  setting an operator can flip. */
export const handleRobotsTxt = async (): Promise<Response> => {
  // The default body stands until the settings load succeeds. A failed load
  // can leave a stale snapshot behind, and a table-less site is treated as
  // off no matter what that snapshot last said.
  let body = PRIVATE_ROBOTS_TXT;
  try {
    await settings.loadKeys([CONFIG_KEYS.ENABLED_FEATURES]);
    body = settings.features.site ? PUBLIC_ROBOTS_TXT : PRIVATE_ROBOTS_TXT;
  } catch (error) {
    // A site before setup has no settings table, so the feature cannot be
    // on and the default body is the answer. Every other failure stays loud.
    if (!isMissingSettingsTableError(error)) throw error;
  }
  return new Response(encodeBody(body), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": TEXT,
    },
  });
};
