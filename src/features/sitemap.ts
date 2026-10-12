/** The /sitemap.xml document: the site's public, indexable URLs in one
 *  sitemaps.org 0.9 urlset. It lists the home page, the fixed pages that
 *  serve, every content page, and every news post. It also lists every
 *  listing and group whose /ticket page serves.
 *
 *  Every entry passes the same checks its public GET handler applies to a
 *  buyer, so the document names only pages that answer 200. The document
 *  carries no <lastmod>: no public page kind holds a timestamp that changes
 *  when the page's content changes. The static path serves before the
 *  request's settings load, so the handler reads its own keys, exactly like
 *  /robots.txt. */

import { getNonStandaloneChildIds } from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
import { isMissingSettingsTableError } from "#db/migrations/errors.ts";
import { getNewsPostSummaries } from "#db/news-posts.ts";
import { settings } from "#db/settings.ts";
import { sitePages } from "#db/site-pages.ts";
import { loadPublicGroups } from "#routes/public/group-liveness.ts";
import {
  loadPublicDomain,
  publicCacheResponse,
} from "#routes/public-origin.ts";
import { isPublicListing } from "#shared/listing-visibility.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { escapeXml } from "#shared/xml.ts";

const SITEMAP_CONTENT_TYPE = "application/xml";

/** The settings keys the sitemap's reads need: the nav flags behind the fixed
 *  pages, and LISTING_DEFAULTS behind the catalog's inherited hidden flags.
 *  The static route serves before the request's settings load, so the handler
 *  declares them itself, exactly like /robots.txt. */
const SITEMAP_SETTINGS_KEYS = [
  CONFIG_KEYS.ENABLED_FEATURES,
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.CONTACT_FORM_ENABLED,
  CONFIG_KEYS.CONTACT_PAGE_TEXT,
  CONFIG_KEYS.LISTING_DEFAULTS,
  CONFIG_KEYS.ORDER_ENABLED,
  CONFIG_KEYS.TERMS_AND_CONDITIONS,
];

/** The fixed pages a visitor can load, with the check each public GET handler
 *  applies. `/` and `/listings` serve behind the public-site gate the whole
 *  sitemap sits behind. The rest answer 404 when their handler's content
 *  check fails. Each is listed only while the check passes, and the flags
 *  are the ones the public nav renders its links from. /news joins them
 *  when the news list has a post to show. */
const fixedPublicPaths = (
  flags: { hasContact: boolean; hasOrder: boolean; hasTerms: boolean },
  hasNews: boolean,
): string[] => {
  const served: [string, boolean][] = [
    ["/", true],
    ["/listings", true],
    ["/terms", flags.hasTerms],
    ["/contact", flags.hasContact],
    ["/order", flags.hasOrder],
    ["/news", hasNews],
  ];
  return served.filter(([, loads]) => loads).map(([path]) => path);
};

const urlEntry = (path: string, domain: string): string => {
  const loc = escapeXml(`https://${domain}${path}`);
  return `  <url><loc>${loc}</loc></url>`;
};

const sitemapNotFound = (): Response =>
  new Response("Not found", { status: 404 });

/** Every public URL the site serves, one <loc> per line. The slugs are stored
 *  sealed, so the reads go through the entity caches that decrypt them. Each
 *  catalog entry passes the checks its own page applies. A listing is
 *  active, not hidden, and bookable on its own. A child that sells only
 *  through its parent has no /ticket page. A group is not hidden and keeps
 *  a page a buyer can book from. A listing or group with an empty slug
 *  names no working page, so it is out with the empty slugs. */
const publicPaths = async (): Promise<string[]> => {
  const [listings, posts, pages, groups] = await Promise.all([
    getAllListings(),
    getNewsPostSummaries(),
    sitePages.getAll(),
    loadPublicGroups(),
  ]);
  const nonStandaloneChildIds = await getNonStandaloneChildIds(
    listings.map((listing) => listing.id),
  );
  // shared.tsx renders the public pages and must stay off the cold-start
  // path. The static sitemap route loads its nav flags only when it serves,
  // like every other public page defers it.
  const { navFlags } = await import("#templates/public/shared.tsx");
  return [
    ...fixedPublicPaths(navFlags(), posts.length > 0),
    ...pages.map((page) => `/page/${page.slug}`),
    ...posts.map((post) => `/news/${post.slug}`),
    ...listings
      .filter(
        (listing) =>
          isPublicListing(listing) &&
          listing.slug !== "" &&
          !nonStandaloneChildIds.has(listing.id),
      )
      .map((listing) => `/ticket/${listing.slug}`),
    ...groups
      .filter(({ group }) => group.slug !== "")
      .map(({ group }) => `/ticket/${group.slug}`),
  ];
};

export const handleSitemapXml = async (request: Request): Promise<Response> => {
  // A site before setup has no settings table, so the feature cannot be on
  // and the 404 is the answer. Every other failure stays loud.
  try {
    await settings.loadKeys(SITEMAP_SETTINGS_KEYS);
  } catch (error) {
    if (!isMissingSettingsTableError(error)) throw error;
    return sitemapNotFound();
  }
  if (!settings.features.site) return sitemapNotFound();

  const domain = await loadPublicDomain(new URL(request.url).hostname);
  const paths = await publicPaths();
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((path) => urlEntry(path, domain)),
    "</urlset>",
    "",
  ].join("\n");
  return publicCacheResponse(body, SITEMAP_CONTENT_TYPE);
};
