/**
 * The img#N lookups: the id→uid-URL tables the markdown render resolves the
 * editor's image references against.
 */

import { imagesTable } from "#db/images.ts";
import { createPrimaryCacheRefill } from "#db/primary-reads.ts";
import { getCurrentSettingsVersion, settings } from "#db/settings.ts";
import { inList } from "#db/where-clauses.ts";
import { lazyRef, mapById } from "#fp";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import { logDbError } from "#shared/logger.ts";
import {
  currentRequestStore,
  getIframeMode,
  withRequestStore,
} from "#shared/request-context.ts";

const imageUrlColumns = imagesTable.read.pick(["id", "filename"]);

/** The id→uid-URL table the markdown render resolves the editor's `img#N`
 * references against. Each entry maps one referenced image's id to its
 * canonical filename URL, so no image is ever addressable by id. */
export type ImageUrls = ReadonlyMap<number, string>;

/** The markdown texts an image-url lookup scans. */
type ImageUrlTexts = readonly (string | null | undefined)[];

/** The image ids the texts name, deduplicated. A text that names no image
 * contributes nothing. */
const referencedImageIds = (texts: ImageUrlTexts): number[] => [
  ...new Set(
    texts
      .filter((text): text is string => typeof text === "string")
      .flatMap((text) =>
        [...text.matchAll(/img#(\d+)/g)]
          .map((match) => Number(match[1]))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
  ),
];

/** The read is bounded by the ids the texts actually reference. It runs only
 * when they name any. */
export const imageUrlsFor = async (
  texts: ImageUrlTexts,
): Promise<ImageUrls> => {
  const ids = referencedImageIds(texts);
  return ids.length === 0
    ? new Map()
    : mapById((row: { id: number; filename: string }) =>
        getImageProxyUrl(row.filename),
      )(await imageUrlColumns.many({}, { where: inList("id", ids) }));
};

/** The footer slot: the one footer text-and-version whose table is held. */
const [getFooterMemo, setFooterMemo] = lazyRef<{
  text: string;
  version: number;
  urls: ImageUrls;
} | null>(() => null);

/** The lookup one cold caller started, shared by the cold callers that ask
 * for the same footer while it runs. Cleared once it settles. */
const [getFooterInflight, setFooterInflight] = lazyRef<{
  generation: number;
  text: string;
  urls: Promise<ImageUrls>;
  version: number;
} | null>(() => null);

/** The number of images writes so far. A lookup that started before a write
 * read the old table. It must not seed the slot, or the footer serves that
 * table until the next write. */
const [getImagesWrites, setImagesWrites] = lazyRef<number>(() => 0);

/** A refill after a committed images write reads the primary. A lagging
 * replica cannot then seed the slot with the rows it read before the
 * write. */
const footerRefill = createPrimaryCacheRefill();

registerTableInvalidation(["images"], (cause) => {
  setImagesWrites(getImagesWrites() + 1);
  setFooterMemo(null);
  footerRefill.afterInvalidation(cause === "write");
});

/** The site footer's id→uid-URL table, memoised by footer text and settings
 * version. Every page that renders the footer calls this, so one lookup
 * serves them all. A hit returns the same table, so repeated renders are
 * byte-identical. A settings write moves the version, and an images write
 * clears the slot here and moves the version for the other isolates, so the
 * next render re-queries. A refill after an images write reads the primary,
 * so a lagging replica cannot seed a stale table. A failed lookup is not
 * memoised, so the next request retries. A footer that names no image reads
 * nothing and returns an empty table. */
export const footerImageUrls = async (text: string): Promise<ImageUrls> => {
  // A footer that names no image always shows no picture: no version read,
  // no memo, no query.
  if (referencedImageIds([text]).length === 0) return new Map();
  // Read fresh: a settings write signals through the version row and
  // bypasses table invalidation, so the per-request probe misses it.
  const version = await getCurrentSettingsVersion();
  const memo = getFooterMemo();
  if (memo && memo.text === text && memo.version === version) {
    return memo.urls;
  }
  const generation = getImagesWrites();
  const started = getFooterInflight();
  if (
    started &&
    started.text === text &&
    started.version === version &&
    started.generation === generation
  ) {
    return started.urls;
  }
  const urls = footerRefill.fetch(() => imageUrlsFor([text]));
  setFooterInflight({ generation, text, urls, version });
  try {
    const table = await urls;
    if (getImagesWrites() === generation) {
      setFooterMemo({ text, urls: table, version });
    }
    return table;
  } finally {
    if (getFooterInflight()?.urls === urls) setFooterInflight(null);
  }
};

/** Merge one id→URL table into the request's page-image slot, which
 * renderMarkdown's default reads. No-op outside a request, so out-of-request
 * work cannot seed a table into any later one. */
export const mergePageImageUrls = (table: ImageUrls): void =>
  withRequestStore((store) => {
    if (!store.pageImageUrls) store.pageImageUrls = new Map();
    for (const [id, url] of table) store.pageImageUrls.set(id, url);
  });

/** Run the bounded lookup for the texts' img#N references and merge the
 * result into the request's page-image slot. No request context → no-op.
 * Texts that name no image query nothing and merge nothing. */
export const addPageImageUrls = async (texts: ImageUrlTexts): Promise<void> => {
  if (!currentRequestStore()) return;
  mergePageImageUrls(await imageUrlsFor(texts));
};

/** Write the site footer's img#N table into the request's footer slot, which
 * the Layout footer's synchronous render reads. The page render paths that
 * show the footer call it before rendering, so requests that render no footer
 * run no lookup. A failed lookup renders the footer without its images
 * instead of failing the page. No request context → no-op. An iframe embed
 * renders no footer, so it runs no lookup either. */
export const addFooterImageUrls = async (): Promise<void> => {
  if (!currentRequestStore() || getIframeMode()) return;
  const table = await footerImageUrls(settings.siteFooter).catch((error) => {
    logDbError("Site footer image lookup failed", error);
    return new Map<number, string>();
  });
  withRequestStore((store) => {
    store.footerImageUrls = table;
  });
};

/** Write the notes' img#N table into the request's page-image slot. The
 * attendees list, the listing panels, and the attendee banner all render
 * system notes. */
export const addNoteImageUrls = async (
  notes: readonly { note: string }[],
): Promise<void> => addPageImageUrls(notes.map((note) => note.note));

/** The pieces of a rendered ticket page whose markdown can name an image. */
export type TicketPageTexts = {
  listings: readonly { listing: { description: string | null } }[];
  questions: readonly { text: string }[];
  groupDescription?: string;
  terms?: string | null;
  packages: readonly { description: string }[];
};

/** Write one ticket page's img#N table into the request's page-image slot.
 * The lookup is one bounded batch over the listing descriptions, the question
 * texts, the group description, the terms, and the packages' descriptions.
 * The submit, quote, and API flows never call it. */
export const addTicketPageImageUrls = async (
  page: TicketPageTexts,
): Promise<void> =>
  addPageImageUrls([
    ...page.listings.map((entry) => entry.listing.description),
    ...page.questions.map((question) => question.text),
    page.groupDescription,
    page.terms,
    ...page.packages.map((pkg) => pkg.description),
  ]);
