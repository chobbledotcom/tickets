/**
 * The img#N lookups: the id→uid-URL tables the markdown render resolves the
 * editor's image references against.
 */

import { imagesTable } from "#db/images.ts";
import { settings } from "#db/settings.ts";
import { inList } from "#db/where-clauses.ts";
import { mapById } from "#fp";
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

/** The read is bounded by the ids the texts actually reference. It runs only
 * when they name any. */
export const imageUrlsFor = async (
  texts: ImageUrlTexts,
): Promise<ImageUrls> => {
  const sources = texts.filter(
    (text): text is string => typeof text === "string",
  );
  const ids = [
    ...new Set(
      sources.flatMap((text) =>
        [...text.matchAll(/img#(\d+)/g)]
          .map((match) => Number(match[1]))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ),
  ];
  return ids.length === 0
    ? new Map()
    : mapById((row: { id: number; filename: string }) =>
        getImageProxyUrl(row.filename),
      )(await imageUrlColumns.many({}, { where: inList("id", ids) }));
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
  const table = await imageUrlsFor([settings.siteFooter]).catch((error) => {
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
