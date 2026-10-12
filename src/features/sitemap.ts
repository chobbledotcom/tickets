/** The /sitemap.xml document: the site's public, indexable URLs in one
 *  sitemaps.org 0.9 urlset. It lists the home page, the fixed pages
 *  (/listings, /terms, /contact, /order, /news), every content page and news
 *  post, and every not-hidden listing and group.
 *
 *  The hidden flag is the same rule the site's own pages apply to a buyer.
 *  The document carries no <lastmod>: no public page kind holds a timestamp
 *  that changes when the page's content changes. The static path serves
 *  before the request's settings load, so the handler reads its own keys,
 *  exactly like /robots.txt. */

import { isMissingSettingsTableError } from "#db/migrations/errors.ts";
import { loadCatalogPair } from "#db/name-registry.ts";
import { getNewsPostSummaries } from "#db/news-posts.ts";
import { settings } from "#db/settings.ts";
import { sitePages } from "#db/site-pages.ts";
import {
  loadPublicDomain,
  publicCacheResponse,
} from "#routes/public-origin.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { escapeXml } from "#shared/xml.ts";

const SITEMAP_CONTENT_TYPE = "application/xml";

/** The fixed public pages every site with the feature on serves. The content
 *  pages and the slugged documents join them at read time. */
const FIXED_PUBLIC_PATHS = [
  "/",
  "/listings",
  "/terms",
  "/contact",
  "/order",
  "/news",
];

const urlEntry = (path: string, domain: string): string => {
  const loc = escapeXml(`https://${domain}${path}`);
  return `  <url><loc>${loc}</loc></url>`;
};

const sitemapNotFound = (): Response =>
  new Response("Not found", { status: 404 });

/** Every public URL the site serves, one <loc> per line. The slugs are stored
 *  sealed, so the reads go through the entity caches that decrypt them. A
 *  hidden listing or group is out (the hidden flag is the rule the buyer sees
 *  too). A listing with an empty slug names no working page, so it is out
 *  with the empty slugs, not with the hidden ones. */
const publicPaths = async (): Promise<string[]> => {
  const [catalog, posts, pages] = await Promise.all([
    loadCatalogPair(),
    getNewsPostSummaries(),
    sitePages.getAll(),
  ]);
  const [listings, allGroups] = catalog;
  return [
    ...FIXED_PUBLIC_PATHS,
    ...pages.map((page) => `/page/${page.slug}`),
    ...posts.map((post) => `/news/${post.slug}`),
    ...listings
      .filter((listing) => !listing.hidden && listing.slug !== "")
      .map((listing) => `/ticket/${listing.slug}`),
    ...allGroups
      .filter((group) => !group.hidden && group.slug !== "")
      .map((group) => `/ticket/${group.slug}`),
  ];
};

export const handleSitemapXml = async (request: Request): Promise<Response> => {
  // A site before setup has no settings table, so the feature cannot be on
  // and the 404 is the answer. Every other failure stays loud.
  try {
    await settings.loadKeys([CONFIG_KEYS.ENABLED_FEATURES]);
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
