// effects: pure
/** The words a scanner page hands its browser code. The page fills each
 * catalog message with its holes left as `{hole}`, and sends the whole set
 * as one JSON attribute. The browser parses the set once, so a missing
 * word fails at page start, and fills each hole from typed values. */

import * as v from "valibot";

/** One word the browser shows: its catalog key and the holes it fills. */
type WordSpec = { holes: readonly string[]; key: string };

/* jscpd:ignore-start -- static data, not code */
export const SCANNER_WORDS = {
  alreadyCheckedIn: {
    holes: ["listingName", "name", "tickets"],
    key: "admin.scanner.already_checked_in",
  },
  cameraDenied: { holes: [], key: "admin.scanner.camera_denied" },
  checkedIn: {
    holes: ["listingName", "name", "tickets"],
    key: "admin.scanner.checked_in",
  },
  checkedInPartial: {
    holes: ["listingName", "name", "tickets", "total"],
    key: "admin.scanner.checked_in_partial",
  },
  checkInButton: { holes: [], key: "admin.scanner.check_in" },
  error: { holes: [], key: "admin.scanner.error" },
  idMismatch: { holes: ["name"], key: "admin.scanner.id_mismatch" },
  invalidQr: { holes: [], key: "admin.scanner.invalid_qr" },
  networkError: { holes: [], key: "admin.scanner.network_error" },
  noDoor: { holes: [], key: "admin.scanner.no_door" },
  notFound: { holes: [], key: "admin.scanner.not_found" },
  offlineAlreadyQueued: {
    holes: [],
    key: "admin.scanner.offline_already_queued",
  },
  offlineBannerAuto: { holes: [], key: "admin.scanner.offline_banner_auto" },
  offlineBannerManual: {
    holes: [],
    key: "admin.scanner.offline_banner_manual",
  },
  offlineCacheExpired: {
    holes: [],
    key: "admin.scanner.offline_cache_expired",
  },
  offlineCacheMissing: {
    holes: [],
    key: "admin.scanner.offline_cache_missing",
  },
  offlineDownloadFailed: {
    holes: [],
    key: "admin.scanner.offline_download_failed",
  },
  offlineDownloading: {
    holes: ["done", "total"],
    key: "admin.scanner.offline_downloading",
  },
  offlineInvalid: { holes: [], key: "admin.scanner.offline_invalid" },
  offlineListTooBig: { holes: [], key: "admin.scanner.offline_list_too_big" },
  offlineNotQueued: { holes: [], key: "admin.scanner.offline_not_queued" },
  offlineQuantityAsk: { holes: [], key: "admin.scanner.offline_quantity_ask" },
  offlineQueued: { holes: [], key: "admin.scanner.offline_queued" },
  offlineReady: { holes: [], key: "admin.scanner.offline_ready" },
  offlineRefreshTooBig: {
    holes: [],
    key: "admin.scanner.offline_refresh_too_big",
  },
  offlineSaveFailed: { holes: [], key: "admin.scanner.offline_save_failed" },
  pageError: { holes: [], key: "admin.scanner.page_error" },
  queueCountOne: { holes: ["count"], key: "admin.scanner.queue_count_one" },
  queueCountOther: { holes: ["count"], key: "admin.scanner.queue_count_other" },
  queueItemAlready: { holes: [], key: "admin.scanner.queue_item_already" },
  queueItemCheckedIn: {
    holes: [],
    key: "admin.scanner.queue_item_checked_in",
  },
  queueItemExpired: { holes: [], key: "admin.scanner.queue_item_expired" },
  queueItemNotCheckedIn: {
    holes: [],
    key: "admin.scanner.queue_item_not_checked_in",
  },
  queueItemOverAdmitted: {
    holes: ["admitted", "bought", "name", "named"],
    key: "admin.scanner.queue_item_over_admitted",
  },
  queueItemQueued: { holes: [], key: "admin.scanner.queue_item_queued" },
  queueItemRefunded: { holes: [], key: "admin.scanner.queue_item_refunded" },
  queueItemStillQueued: {
    holes: [],
    key: "admin.scanner.queue_item_still_queued",
  },
  refunded: { holes: ["name"], key: "admin.scanner.refunded" },
  scanning: { holes: [], key: "admin.scanner.scanning" },
  searchButton: { holes: [], key: "admin.scanner.search_button" },
  searchFailed: { holes: [], key: "admin.scanner.search_failed" },
  searchNone: { holes: [], key: "admin.scanner.search_none" },
  searchTooShort: { holes: [], key: "admin.scanner.search_too_short" },
  selectQuantity: { holes: ["name"], key: "admin.scanner.select_quantity" },
  skipped: { holes: ["name"], key: "admin.scanner.skipped" },
  storageBlocked: { holes: [], key: "admin.scanner.storage_blocked" },
  syncDone: { holes: [], key: "admin.scanner.sync_done" },
  syncHolds: { holes: [], key: "admin.scanner.sync_holds" },
  syncRunning: { holes: [], key: "admin.scanner.sync_running" },
  syncStillQueued: { holes: [], key: "admin.scanner.sync_still_queued" },
  ticketCountOne: { holes: ["count"], key: "admin.scanner.ticket_count_one" },
  ticketCountOther: {
    holes: ["count"],
    key: "admin.scanner.ticket_count_other",
  },
  ticketOption: {
    holes: ["name", "tickets"],
    key: "admin.scanner.ticket_option",
  },
  ticketOptionDetail: {
    holes: ["detail", "name", "tickets"],
    key: "admin.scanner.ticket_option_detail",
  },
  verifyIdConfirm: { holes: ["name"], key: "admin.scanner.verify_id_confirm" },
  wrongListingConfirm: {
    holes: ["listingName", "name"],
    key: "admin.scanner.wrong_listing_confirm",
  },
} as const satisfies Record<string, WordSpec>;
/* jscpd:ignore-end */

/** The name of one word the browser shows. */
export type WordName = keyof typeof SCANNER_WORDS;

/** The holes one word fills. */
type HoleOf<Name extends WordName> =
  (typeof SCANNER_WORDS)[Name]["holes"][number];

/** A word that fills no holes. */
export type PlainWord = {
  [Name in WordName]: HoleOf<Name> extends never ? Name : never;
}[WordName];

/** Every word, as the page sends it: the catalog text with its holes left
 * as `{hole}`. */
export type ScannerWords = Record<WordName, string>;

const WORD_NAMES = Object.keys(SCANNER_WORDS) as WordName[];

/** The words a scanner page sends. The browser parses them once. */
export const ScannerWordsSchema = v.object(
  Object.fromEntries(WORD_NAMES.map((name) => [name, v.string()])) as Record<
    WordName,
    v.StringSchema<undefined>
  >,
);

/** The words one page shows, with each hole filled from typed values. A
 * word's holes are the keys its values must carry. */
export type Wording = {
  fill: <Name extends WordName>(
    name: Name,
    values: Record<HoleOf<Name>, number | string>,
  ) => string;
  ticketCount: (count: number) => string;
  word: (name: PlainWord) => string;
};

/** The wording for one page's words. */
export const wordingOf = (words: ScannerWords): Wording => {
  const fill: Wording["fill"] = (name, values) =>
    words[name].replace(/\{(\w+)\}/g, (_, hole: string) =>
      String(values[hole as keyof typeof values]),
    );
  return {
    fill,
    ticketCount: (count) =>
      fill(count === 1 ? "ticketCountOne" : "ticketCountOther", { count }),
    word: (name) => words[name],
  };
};
