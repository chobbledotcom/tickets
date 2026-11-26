import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { t } from "#i18n";
import {
  SCANNER_WORDS,
  type ScannerWords,
  ScannerWordsSchema,
} from "#shared/scanner-words.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

/** Each word's catalog key, written out by hand beside the word it belongs
 * to. The table the template reads cannot supply this map's facts, so a
 * key swapped between two words with the same holes fails here. */
/* jscpd:ignore-start -- static data, not code */
const EXPECTED_KEYS: Record<keyof ScannerWords, string> = {
  alreadyCheckedIn: "admin.scanner.already_checked_in",
  cameraDenied: "admin.scanner.camera_denied",
  checkedIn: "admin.scanner.checked_in",
  checkedInPartial: "admin.scanner.checked_in_partial",
  checkInButton: "admin.scanner.check_in",
  error: "admin.scanner.error",
  idMismatch: "admin.scanner.id_mismatch",
  invalidQr: "admin.scanner.invalid_qr",
  networkError: "admin.scanner.network_error",
  noDoor: "admin.scanner.no_door",
  notFound: "admin.scanner.not_found",
  offlineAlreadyQueued: "admin.scanner.offline_already_queued",
  offlineBannerAuto: "admin.scanner.offline_banner_auto",
  offlineBannerAutoOff: "admin.scanner.offline_banner_auto_off",
  offlineBannerManual: "admin.scanner.offline_banner_manual",
  offlineCacheExpired: "admin.scanner.offline_cache_expired",
  offlineCacheMissing: "admin.scanner.offline_cache_missing",
  offlineDownloadFailed: "admin.scanner.offline_download_failed",
  offlineDownloading: "admin.scanner.offline_downloading",
  offlineInvalid: "admin.scanner.offline_invalid",
  offlineListTooBig: "admin.scanner.offline_list_too_big",
  offlineNotQueued: "admin.scanner.offline_not_queued",
  offlineQuantityAsk: "admin.scanner.offline_quantity_ask",
  offlineQueued: "admin.scanner.offline_queued",
  offlineReady: "admin.scanner.offline_ready",
  offlineRefreshTooBig: "admin.scanner.offline_refresh_too_big",
  offlineSaveFailed: "admin.scanner.offline_save_failed",
  pageError: "admin.scanner.page_error",
  queueCountOne: "admin.scanner.queue_count_one",
  queueCountOther: "admin.scanner.queue_count_other",
  queueItemAlready: "admin.scanner.queue_item_already",
  queueItemCheckedIn: "admin.scanner.queue_item_checked_in",
  queueItemExpired: "admin.scanner.queue_item_expired",
  queueItemNotCheckedIn: "admin.scanner.queue_item_not_checked_in",
  queueItemOverAdmitted: "admin.scanner.queue_item_over_admitted",
  queueItemQueued: "admin.scanner.queue_item_queued",
  queueItemRefunded: "admin.scanner.queue_item_refunded",
  queueItemStillQueued: "admin.scanner.queue_item_still_queued",
  refunded: "admin.scanner.refunded",
  scanning: "admin.scanner.scanning",
  searchButton: "admin.scanner.search_button",
  searchFailed: "admin.scanner.search_failed",
  searchNone: "admin.scanner.search_none",
  searchTooShort: "admin.scanner.search_too_short",
  selectQuantity: "admin.scanner.select_quantity",
  skipped: "admin.scanner.skipped",
  storageBlocked: "admin.scanner.storage_blocked",
  syncDone: "admin.scanner.sync_done",
  syncHolds: "admin.scanner.sync_holds",
  syncRunning: "admin.scanner.sync_running",
  syncStillQueued: "admin.scanner.sync_still_queued",
  ticketCountOne: "admin.scanner.ticket_count_one",
  ticketCountOther: "admin.scanner.ticket_count_other",
  ticketOption: "admin.scanner.ticket_option",
  ticketOptionDetail: "admin.scanner.ticket_option_detail",
  verifyIdConfirm: "admin.scanner.verify_id_confirm",
  wrongListingConfirm: "admin.scanner.wrong_listing_confirm",
};
/* jscpd:ignore-end */

/** The words one rendered page sends its browser code. */
const pageWords = (html: string) => {
  const attribute = html.match(/data-words="([^"]*)"/)?.[1];
  if (attribute === undefined) throw new Error("The page sends no words.");
  return v.parse(
    ScannerWordsSchema,
    JSON.parse(attribute.replaceAll("&quot;", '"').replaceAll("&amp;", "&")),
  );
};

describe("the scanner page's words", () => {
  beforeAll(setupAdminPageTest);

  test("sends every word once, each the catalog's words with its holes left open", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      false,
      "test-door-cache-key",
      7,
    );
    expect(html.split("data-words=").length - 1).toBe(1);
    const words = pageWords(html);
    for (const [name, { holes }] of Object.entries(SCANNER_WORDS)) {
      const word = name as keyof ScannerWords;
      const open = Object.fromEntries(holes.map((hole) => [hole, `{${hole}}`]));
      // The expected key comes from this file's own map, not the table the
      // template reads, so a key swapped between two words with the same
      // holes fails this assertion.
      expect(SCANNER_WORDS[word].key, word).toBe(EXPECTED_KEYS[word]);
      expect(words[word], word).toBe(t(EXPECTED_KEYS[word], open));
    }
    // The client reads its CSRF token from this meta; without it every scan
    // POST fails the token check.
    assertStringIncludes(html, '<meta name="csrf-token"');
  });
});
