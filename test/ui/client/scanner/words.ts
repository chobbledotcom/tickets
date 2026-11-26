/** The words a scanner page sends its browser code, as the template fills
 * them from the English catalog: each hole stays as `{hole}`. Every scanner
 * fixture renders these, so a test reads the words a door reads. */

import type { ScannerWords } from "#shared/scanner-words.ts";

/* jscpd:ignore-start -- static data, not code */
export const PAGE_WORDS: ScannerWords = {
  alreadyCheckedIn: "{name} already checked in for {listingName} ({tickets})",
  cameraDenied:
    "The camera is blocked. Allow camera access for this site, then try again.",
  checkedIn: "{name} checked in for {listingName} ({tickets})",
  checkedInPartial:
    "{name} checked in for {listingName} ({tickets} of {total} tickets)",
  checkInButton: "Check In",
  error: "The check-in did not work. Try again.",
  idMismatch: "ID does not match {name}",
  invalidQr: "This QR code is not a ticket.",
  networkError:
    "Could not reach the server. Check your connection, then try again.",
  noDoor: "This ticket has no door to check in at.",
  notFound: "This ticket was not found. Check that it is for this event.",
  offlineAlreadyQueued:
    "This ticket is already queued. Do not let them in again.",
  offlineBannerAuto:
    "No connection. Scans are queued and checked in when you are back online.",
  offlineBannerAutoOff:
    "No connection. Turn on offline mode while you have a connection to scan without one.",
  offlineBannerManual:
    "Offline mode is on. Scans are queued and checked in when you are back online.",
  offlineCacheExpired:
    "The offline ticket list has expired. Go online and reload this page.",
  offlineCacheMissing:
    "No offline ticket list on this device. Go online and turn on offline mode first.",
  offlineDownloadFailed:
    "The ticket list did not download. Check your connection, then try again.",
  offlineDownloading: "Downloading the ticket list ({done} of {total} people)",
  offlineInvalid:
    "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
  offlineListTooBig:
    "The ticket list is too big to save on this device. Keep scanning online.",
  offlineNotQueued:
    "Nothing was queued. Scan the ticket again to check them in.",
  offlineQuantityAsk: "How many people are you checking in?",
  offlineQueued:
    "Ticket looks valid. It will be checked in when you are back online.",
  offlineQueueUnreadable:
    "This device holds queued check-ins this page cannot read. Offline mode is off on this page. Scanning online still works.",
  offlineReady: "Offline mode is on. The ticket list is saved on this device.",
  offlineRefreshTooBig:
    "The new ticket list is too big for this device. The saved list stays until it expires.",
  offlineSaveFailed:
    "This was not saved because this device has no room left for this site. Turn offline mode off to free the space.",
  pageError: "Something went wrong. Reload this page, then try again.",
  queueCountOne: "{count} queued check-in",
  queueCountOther: "{count} queued check-ins",
  queueItemAlready: "Was already checked in",
  queueItemCheckedIn: "Checked in",
  queueItemExpired:
    "This queued check-in is too old to send. Scan the ticket again while you are online.",
  queueItemNotCheckedIn: "Not checked in",
  queueItemOverAdmitted:
    "Alert: {name} — this check-in was for {named}, but the booking only had {admitted} left. The booking holds {bought} in total.",
  queueItemQueued: "Waiting — will be checked in when online",
  queueItemRefunded: "Refunded — not checked in",
  queueItemStillQueued: "Not sent yet — still queued",
  refunded: "{name} has been refunded",
  scanning: "Scanning...",
  searchButton: "Search",
  searchFailed: "The search did not work. Try again.",
  searchNone: "Nobody at this door matches that name.",
  searchTooShort: "Type at least 2 letters of the name.",
  selectQuantity: "How many tickets for {name}?",
  skipped: "Skipped {name}",
  storageBlocked:
    "This browser blocks this site from saving data. Allow site data for this site, then reload this page.",
  syncDone: "Queued tickets are done.",
  syncHolds: "Checking in queued tickets. Scan again when done.",
  syncRunning: "Checking in queued tickets...",
  syncStillQueued:
    "Some tickets are still queued. The page will try to check them in again.",
  ticketCountOne: "{count} ticket",
  ticketCountOther: "{count} tickets",
  ticketOption: "{name} ({tickets})",
  ticketOptionDetail: "{name} ({tickets}) — {detail}",
  verifyIdConfirm: 'Does their ID match "{name}"?',
  wrongListingConfirm:
    '{name} is registered for "{listingName}", not this listing. Check in anyway?',
};
/* jscpd:ignore-end */

/** The `data-words` attribute that carries `words`, escaped for HTML. */
export const wordsAttribute = (words: ScannerWords = PAGE_WORDS): string =>
  `data-words="${JSON.stringify(words).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`;

/** The page's words with some replaced, the way a rebrand rewrites the
 * catalog. */
export const wordsWith = (changes: Partial<ScannerWords>): ScannerWords => ({
  ...PAGE_WORDS,
  ...changes,
});
