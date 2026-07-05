/**
 * Attachment download route — serves encrypted listing attachments from Bunny CDN.
 * GET /attachment/:id?a=attendeeId&exp=timestamp&sig=hmacSignature
 *
 * URLs are signed with HMAC and time-limited (1 hour) to prevent sharing.
 * Each download increments the attendee's attachment_downloads counter.
 */

import { typeByExtension } from "@std/media-types";
import { extname } from "@std/path";
import { notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import { verifyAttachmentUrl } from "#shared/attachment-url.ts";
import {
  hasActiveBookingLine,
  incrementAttachmentDownloads,
} from "#shared/db/attendees.ts";
import { getListing } from "#shared/db/listings.ts";
import {
  downloadImage,
  getBasename,
  isStorageEnabled,
} from "#shared/storage.ts";

/** Get MIME type from a filename's extension, defaulting to octet-stream */
export const getMimeType = (filename: string): string =>
  typeByExtension(extname(filename).slice(1).toLowerCase()) ??
  "application/octet-stream";

/** Return a 403 forbidden response */
const forbiddenResponse = (): Response =>
  new Response("Forbidden", { status: 403 });

/**
 * Sanitize an attachment name for use in the Content-Disposition header.
 * Strips characters that could be used for HTTP header injection or path traversal.
 */
const sanitizeAsciiFilename = (name: string): string => {
  const basename = getBasename(name);
  return (
    basename.replace(/[^\x20-\x7E]/g, "").replace(/[":;\\]/g, "_") || "file"
  );
};

/** RFC 5987-encode a filename for the filename* parameter (UTF-8 percent-encoded). */
const encodeRfc5987 = (name: string): string => {
  const bytes = new TextEncoder().encode(getBasename(name) || "file");
  let out = "";
  for (const byte of bytes) {
    // attr-char per RFC 5987 §3.2.1 — alphanumerics plus a small set of safe punctuation
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
};

/** Build a Content-Disposition value with both ASCII filename and RFC 5987 filename*. */
const buildContentDisposition = (name: string): string => {
  const ascii = sanitizeAsciiFilename(name);
  const encoded = encodeRfc5987(name);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

/** Handle GET /attachment/:id */
const handleAttachmentDownload: TypedRouteHandler<
  "GET /attachment/:id"
> = async (request, { id }) => {
  if (!isStorageEnabled()) return notFoundResponse();

  // Extract and validate query params
  const url = new URL(request.url);
  const attendeeIdStr = url.searchParams.get("a");
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!attendeeIdStr || !exp || !sig) return forbiddenResponse();

  const attendeeId = Number.parseInt(attendeeIdStr, 10);
  if (Number.isNaN(attendeeId)) return forbiddenResponse();

  // Verify signature and expiry
  const valid = await verifyAttachmentUrl(id, attendeeId, exp, sig);
  if (!valid) return forbiddenResponse();

  // Look up listing and verify it has an attachment
  const listing = await getListing(id);
  if (!listing?.attachment_url) return notFoundResponse();

  // Authorize against the EXACT (attendee, listing) booking row with a real
  // (quantity > 0) line — not a left-joined sibling row. A line later marked
  // no-quantity stops authorizing the protected attachment.
  if (!(await hasActiveBookingLine(attendeeId, id))) return forbiddenResponse();

  // Download and decrypt from CDN
  const data = await downloadImage(listing.attachment_url);
  if (!data) return notFoundResponse();

  // Increment download counter (fire-and-forget)
  await incrementAttachmentDownloads(attendeeId, id);

  // Serve with Content-Disposition for proper download filename
  const contentType = getMimeType(listing.attachment_name);
  const disposition = buildContentDisposition(listing.attachment_name);
  return new Response(data.buffer as BodyInit, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-disposition": disposition,
      "content-type": contentType,
    },
  });
};

/** Attachment routes */
const attachmentRoutes = defineRoutes({
  "GET /attachment/:id": handleAttachmentDownload,
});

export { attachmentRoutes };
