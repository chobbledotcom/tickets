import * as v from "valibot";
import {
  type EvidenceCaptureDeclaration,
  EvidenceCaptureDeclarationSchema,
} from "./schema.ts";

/** One branded mobile capture: the page an authored case leaves behind and the
 * part of it worth showing. What the page is dressed in is not said here: see
 * themes.ts, because a screenshot's look belongs to whoever publishes it. */
const brandedMobileCapture = (
  caseId: string,
  id: string,
  path: string,
  element: string,
): EvidenceCaptureDeclaration =>
  v.parse(EvidenceCaptureDeclarationSchema, {
    caseId,
    element,
    id,
    path,
    presentation: "branded",
    profiles: ["mobile"],
  });

export const EVIDENCE_CAPTURES: EvidenceCaptureDeclaration[] = [
  brandedMobileCapture(
    "servicing.hold-on-dashboard",
    "servicing-studio-floor-hold",
    "/admin/servicing/{servicingEventId}",
    "#servicing-form",
  ),
  brandedMobileCapture(
    "payments.select-saved-stripe",
    "payment-provider-choice",
    "/admin/settings",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "deposit.balance-page-shows-what-is-left",
    "balance-payment-link",
    "/pay/{balanceToken}",
    ".page-regions.public-page",
  ),
  brandedMobileCapture(
    "contact-record.a-record-with-a-history-behind-it",
    "contact-record",
    "/admin/history/{contactCode}",
    "#contact-history-form",
  ),
  brandedMobileCapture(
    "bundles.the-parts-are-named-on-the-booking-page",
    "bundle-booking-page",
    "/ticket/{bundleSlug}",
    ".page-regions.public-page",
  ),
  brandedMobileCapture(
    "bookings.volunteer-chooses-shift",
    "volunteer-shift-form",
    "/ticket/{volunteerGroupSlug}",
    ".page-regions.public-page",
  ),
  brandedMobileCapture(
    "editors.joining-from-an-invite",
    "team-and-roles",
    "/admin/users",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "paid-booking.recorded-once",
    "listing-ledger",
    "/admin/ledger/revenue/{paidListingId}",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "site-pages.written-and-readable",
    "page-anybody-can-read",
    "/page/{sitePageAddress}",
    "main",
  ),
  brandedMobileCapture(
    "api-keys.made-and-shown-once",
    "api-keys-list",
    "/admin/api-keys",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "payment.refund-undoes-the-sale",
    "refunded-booking",
    "/admin/attendees/{paidBookingId}/ledger",
    "#attendee-money",
  ),
  brandedMobileCapture(
    "booking.group-page-journey",
    "group-booking-arrives",
    "/admin/listing/{groupBookingListingId}/attendees",
    "main",
  ),
  brandedMobileCapture(
    "payment.place-lost",
    "place-lost-while-paying",
    "/admin/attendees/{lostPlaceAttendeeId}",
    ".system-note-alert",
  ),
  brandedMobileCapture(
    "site-pages.moved-into-order",
    "site-pages-in-order",
    "/admin/site/pages",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "add-ons.it-appears-in-the-list-with-its-own-link",
    "add-on-in-the-list",
    "/listings",
    "main",
  ),
  brandedMobileCapture(
    "stay-length.the-length-is-on-the-listing-page",
    "stay-length-on-the-page",
    "/admin/listing/{stayLengthListingId}",
    "main",
  ),
  brandedMobileCapture(
    "pay-more.the-chosen-price-is-the-income",
    "paid-more-than-asked",
    "/admin/ledger/revenue/{payMoreListingId}",
    ".page-regions.admin-page",
  ),
  brandedMobileCapture(
    "door.the-day-is-written-down",
    "checked-in-on-the-day",
    "/admin/listing/{checkedInListingId}/activity",
    "main",
  ),
  brandedMobileCapture(
    "contact-record.correcting-the-counts-and-the-note",
    "record-put-right",
    "/admin/history/{contactCode}",
    "#contact-history-form",
  ),
  brandedMobileCapture(
    "contact-record.repairing-an-unreadable-record",
    "record-repaired",
    "/admin/history/{contactCode}",
    "#contact-history-form",
  ),
  brandedMobileCapture(
    "door.someone-still-to-arrive-can-be-picked",
    "qr-code-check-in",
    "/admin/listing/{doorListingId}/scanner",
    "article:has(#manual-checkin)",
  ),
];
