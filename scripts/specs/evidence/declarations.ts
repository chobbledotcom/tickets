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
    "door.someone-still-to-arrive-can-be-picked",
    "qr-code-check-in",
    "/admin/listing/{doorListingId}/scanner",
    "article:has(#manual-checkin)",
  ),
];
