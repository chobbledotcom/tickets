/**
 * The id-to-URL lookup the markdown render resolves img#N references with.
 */

import { imagesTable } from "#db/images.ts";
/* jscpd:ignore-start */
import { getCurrentSettingsVersion } from "#db/settings.ts";
import { inList } from "#db/where-clauses.ts";
import { lazyRef, mapById } from "#fp";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import {
  currentRequestStore,
  withRequestStore,
} from "#shared/request-context.ts";

/* jscpd:ignore-end */

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

/** The per-isolate id→URL cache. The whole map is valid for one settings
 * version. Every images write bumps that version in its transaction, so a
 * write makes the next lookup drop the map. The migration runner bumps it
 * when it records a batch. Any other write to the images rows — an operator's
 * out-of-band SQL — must bump the same SETTINGS_VERSION row. Otherwise the
 * map stays until some spine write lands. Apps live about 30 seconds, so a
 * warm entry dies before staleness matters. The version check is the only
 * staleness signal the cache needs. */
const cacheBound = 200;

const [getCache, setCache] = lazyRef<{
  urls: Map<number, string>;
  version: number;
} | null>(() => null);

registerTableInvalidation(["images"], () => {
  setCache(null);
});

/** The read is bounded by the ids the texts actually reference. Answers come
 * from the cache while its version matches. The misses share one batched
 * query, and a failed lookup fills nothing. A fill that carries the map
 * past the bound resets it, so the map never grows without limit. It runs
 * only when the texts name any image. */
export const imageUrlsFor = async (
  texts: ImageUrlTexts,
): Promise<ImageUrls> => {
  const ids = referencedImageIds(texts);
  if (ids.length === 0) return new Map();
  const version = await getCurrentSettingsVersion();
  const cache = getCache();
  const cached = cache?.version === version ? cache.urls : undefined;
  const table = new Map<number, string>();
  const missing: number[] = [];
  for (const id of ids) {
    const url = cached?.get(id);
    if (url === undefined) missing.push(id);
    else table.set(id, url);
  }
  if (missing.length === 0) return table;
  const fetched = mapById((row: { id: number; filename: string }) =>
    getImageProxyUrl(row.filename),
  )(await imageUrlColumns.many({}, { where: inList("id", missing) }));
  for (const [id, url] of fetched) table.set(id, url);
  const warm = cached ?? new Map<number, string>();
  for (const [id, url] of fetched) warm.set(id, url);
  if (warm.size > cacheBound) setCache({ urls: new Map(), version });
  else setCache({ urls: warm, version });
  return table;
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
  footer?: string | null;
  packages: readonly { description: string }[];
};

/** Write one ticket page's img#N table into the request's page-image slot.
 * The lookup is one bounded batch over the listing descriptions, the question
 * texts, the group description, the terms, the site footer, and the packages'
 * descriptions. The submit, quote, and API flows never call it. */
export const addTicketPageImageUrls = async (
  page: TicketPageTexts,
): Promise<void> =>
  addPageImageUrls([
    ...page.listings.map((entry) => entry.listing.description),
    ...page.questions.map((question) => question.text),
    page.groupDescription,
    page.terms,
    page.footer,
    ...page.packages.map((pkg) => pkg.description),
  ]);
