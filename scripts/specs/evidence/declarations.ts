import * as v from "valibot";
import {
  type EvidenceCaptureDeclaration,
  EvidenceCaptureDeclarationSchema,
} from "./schema.ts";

/** One declared capture, still carrying its own id in the type. That is what
 * lets the capture ids below be the whole list a story can leave a page for. */
type DeclaredCapture<Id extends string> = EvidenceCaptureDeclaration & {
  id: Id;
};

/**
 * One branded mobile capture: the page an authored case leaves behind and the
 * part of it worth showing. What the page is dressed in is not said here: see
 * themes.ts, because a screenshot's look belongs to whoever publishes it.
 *
 * A page that is always at the same address says so with `path`. A page whose
 * address the story only knows once it has run — a new listing's number, a
 * signed link, a one-way code — leaves `path` out, and the story hands the
 * finished address over with leaveEvidencePage.
 */
const brandedMobileCapture = <Id extends string>(
  caseId: string,
  id: Id,
  element: string,
  path?: string,
): DeclaredCapture<Id> => {
  const declaration = {
    caseId,
    element,
    id,
    path,
    presentation: "branded" as const,
    profiles: ["mobile" as const],
  };
  const checked = v.parse(EvidenceCaptureDeclarationSchema, declaration);
  // The checked values are the ones to keep; the id is put back only to hold
  // on to its own name in the type, and checking never changes an id.
  return { ...checked, id };
};

export const EVIDENCE_CAPTURES = [
  brandedMobileCapture(
    "writing.one-day-hears-and-the-others-do-not",
    "one-days-audience",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "servicing.hold-on-dashboard",
    "servicing-studio-floor-hold",
    "#servicing-form",
  ),
  brandedMobileCapture(
    "payments.select-saved-stripe",
    "payment-provider-choice",
    ".page-regions.admin-page",
    "/admin/settings",
  ),
  brandedMobileCapture(
    "deposit.balance-page-shows-what-is-left",
    "balance-payment-link",
    ".page-regions.public-page",
  ),
  brandedMobileCapture(
    "contact-record.a-record-with-a-history-behind-it",
    "contact-record",
    "#contact-history-form",
  ),
  brandedMobileCapture(
    "bundles.the-parts-are-named-on-the-booking-page",
    "bundle-booking-page",
    ".page-regions.public-page",
  ),
  brandedMobileCapture(
    "bookings.volunteer-chooses-shift",
    "volunteer-shift-form",
    ".page-regions.public-page",
  ),
  brandedMobileCapture(
    "editors.joining-from-an-invite",
    "team-and-roles",
    ".page-regions.admin-page",
    "/admin/users",
  ),
  brandedMobileCapture(
    "paid-booking.recorded-once",
    "listing-ledger",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "site-pages.written-and-readable",
    "page-anybody-can-read",
    "main",
  ),
  brandedMobileCapture(
    "api-keys.made-and-shown-once",
    "api-keys-list",
    ".page-regions.admin-page",
    "/admin/api-keys",
  ),
  brandedMobileCapture(
    "payment.refund-undoes-the-sale",
    "refunded-booking",
    "#attendee-money",
  ),
  brandedMobileCapture(
    "booking.group-page-journey",
    "group-booking-arrives",
    "main",
  ),
  brandedMobileCapture(
    "payment.place-lost",
    "place-lost-while-paying",
    ".system-note-alert",
  ),
  brandedMobileCapture(
    "site-pages.moved-into-order",
    "site-pages-in-order",
    ".page-regions.admin-page",
    "/admin/site/pages",
  ),
  brandedMobileCapture(
    "editors.the-listings-show-no-money",
    "editor-listings-without-takings",
    ".page-regions.admin-page",
    "/admin/listings",
  ),
  brandedMobileCapture(
    "backup.restore-brings-back-bookings",
    "backup-restore",
    ".page-regions.entity-page",
  ),
  brandedMobileCapture(
    "download.the-chosen-length-not-the-maximum",
    "attendee-csv-export",
    "main",
  ),
  brandedMobileCapture(
    "add-ons.it-appears-in-the-list-with-its-own-link",
    "add-on-in-the-list",
    "main",
    "/listings",
  ),
  brandedMobileCapture(
    "stay-length.the-length-is-on-the-listing-page",
    "stay-length-on-the-page",
    "main",
  ),
  brandedMobileCapture(
    "pay-more.the-chosen-price-is-the-income",
    "paid-more-than-asked",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "door.the-day-is-written-down",
    "checked-in-on-the-day",
    "main",
  ),
  brandedMobileCapture(
    "contact-record.correcting-the-counts-and-the-note",
    "record-put-right",
    "#contact-history-form",
  ),
  brandedMobileCapture(
    "contact-record.repairing-an-unreadable-record",
    "record-repaired",
    "#contact-history-form",
  ),
  brandedMobileCapture(
    "door.someone-still-to-arrive-can-be-picked",
    "qr-code-check-in",
    "article:has(#manual-checkin)",
  ),
];

/** Every screenshot this repo takes. A story can only leave a page for one of
 * these names, so a typo is a compile error rather than a screenshot of the
 * wrong page. */
export type EvidenceCaptureId = (typeof EVIDENCE_CAPTURES)[number]["id"];
