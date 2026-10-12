/** The domain the site's public absolute URLs name. Static paths serve before
 *  the request's settings load, so /robots.txt and /sitemap.xml read these
 *  keys for themselves instead of trusting the snapshot. */

import { settings } from "#db/settings.ts";
import { encodeBody } from "#routes/response.ts";
import { effectiveDomainFromSettings } from "#shared/config.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

/** A body with the short public cache: it follows settings an operator can
 *  flip, so no proxy holds it for long. /robots.txt and /sitemap.xml share
 *  it, so the two static documents cannot age differently. */
export const publicCacheResponse = (
  body: string,
  contentType: string,
): Response =>
  new Response(encodeBody(body), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": contentType,
    },
  });

/** Resolve the public domain for a request: the configured custom domain when
 *  validated, else the Bunny subdomain, else the host the request named. */
export const loadPublicDomain = async (
  requestHost: string,
): Promise<string> => {
  await settings.loadKeys([
    CONFIG_KEYS.CUSTOM_DOMAIN,
    CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
    CONFIG_KEYS.BUNNY_SUBDOMAIN,
  ]);
  return effectiveDomainFromSettings(
    settings.customDomain,
    settings.bunnySubdomain,
    settings.customDomainLastValidated,
    requestHost,
  );
};
