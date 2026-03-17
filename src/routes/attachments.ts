/**
 * Attachment download route — serves encrypted event attachments from Bunny CDN.
 * GET /attachment/:id?a=attendeeId&exp=timestamp&sig=hmacSignature
 *
 * URLs are signed with HMAC and time-limited (1 hour) to prevent sharing.
 * Each download increments the attendee's attachment_downloads counter.
 */

import { verifyAttachmentUrl } from "#lib/attachment-url.ts";
import {
  getAttendeeRaw,
  incrementAttachmentDownloads,
} from "#lib/db/attendees.ts";
import { getEvent } from "#lib/db/events.ts";
import { downloadImage, isStorageEnabled } from "#lib/storage.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** Common MIME types by file extension */
const EXT_MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
};

/** Get MIME type from a filename's extension, defaulting to octet-stream */
export const getMimeType = (filename: string): string => {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return "application/octet-stream";
  const ext = filename.slice(dotIndex).toLowerCase();
  return EXT_MIME_MAP[ext] ?? "application/octet-stream";
};

/** Return a 403 forbidden response */
const forbiddenResponse = (): Response =>
  new Response("Forbidden", { status: 403 });

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

  // Look up event and verify it has an attachment
  const event = await getEvent(id);
  if (!event || !event.attachment_url) return notFoundResponse();

  // Verify attendee exists and belongs to this event
  const attendee = await getAttendeeRaw(attendeeId);
  if (!attendee || attendee.event_id !== id) return forbiddenResponse();

  // Download and decrypt from CDN
  const data = await downloadImage(event.attachment_url);
  if (!data) return notFoundResponse();

  // Increment download counter (fire-and-forget)
  await incrementAttachmentDownloads(attendeeId);

  // Serve with Content-Disposition for proper download filename
  const contentType = getMimeType(event.attachment_name);
  return new Response(data.buffer as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${event.attachment_name.replace(/"/g, '\\"')}"`,
      "cache-control": "public, max-age=3600",
    },
  });
};

/** Attachment routes */
const attachmentRoutes = defineRoutes({
  "GET /attachment/:id": handleAttachmentDownload,
});

export { attachmentRoutes };
