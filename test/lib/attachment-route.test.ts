import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { signAttachmentUrl } from "#lib/attachment-url.ts";
import { encryptBytes } from "#lib/crypto.ts";
import { getAttendeeRaw } from "#lib/db/attendees.ts";
import { eventsTable } from "#lib/db/events.ts";
import { handleRequest } from "#routes";
import { getMimeType } from "#routes/attachments.ts";
import {
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  installUrlHandler,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setupTestEncryptionKey,
  withFetchMock,
} from "#test-utils";

describe("getMimeType", () => {
  test("returns application/pdf for .pdf", () => {
    expect(getMimeType("file.pdf")).toBe("application/pdf");
  });

  test("returns image/jpeg for .jpg", () => {
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
  });

  test("returns text/plain for .txt", () => {
    expect(getMimeType("readme.txt")).toBe("text/plain");
  });

  test("returns video/mp4 for .mp4", () => {
    expect(getMimeType("video.mp4")).toBe("video/mp4");
  });

  test("returns application/octet-stream for unknown extension", () => {
    expect(getMimeType("file.xyz")).toBe("application/octet-stream");
  });

  test("returns application/octet-stream for no extension", () => {
    expect(getMimeType("noextension")).toBe("application/octet-stream");
  });

  test("handles uppercase extensions", () => {
    expect(getMimeType("FILE.PDF")).toBe("application/pdf");
    expect(getMimeType("PHOTO.JPG")).toBe("image/jpeg");
  });
});

describe("GET /attachment/:id", () => {
  beforeEach(async () => {
    setupTestEncryptionKey();
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    Deno.env.delete("STORAGE_ZONE_NAME");
    Deno.env.delete("STORAGE_ZONE_KEY");
    resetDb();
  });

  /** Enable storage by setting the required env vars */
  const enableStorage = () => {
    Deno.env.set("STORAGE_ZONE_NAME", "testzone");
    Deno.env.set("STORAGE_ZONE_KEY", "testkey");
  };

  /** Create an event+attendee with an attachment configured */
  const setupAttachment = async () => {
    const { event, attendee } = await createTestAttendeeWithToken(
      "Test User",
      "test@example.com",
    );
    await eventsTable.update(event.id, {
      attachmentUrl: "file.pdf",
      attachmentName: "guide.pdf",
    });
    return { eventId: event.id, attendeeId: attendee.id };
  };

  /** Sign a URL and return the full path with query params */
  const signUrl = async (
    eventId: number,
    attendeeId: number,
  ): Promise<string> => {
    return await signAttachmentUrl(eventId, attendeeId);
  };

  /** Mock CDN fetch to return encrypted data */
  const withCdnMock = (
    data: Uint8Array,
    fn: () => Promise<void>,
  ): Promise<void> =>
    withFetchMock(async (originalFetch) => {
      const encrypted = await encryptBytes(data);
      installUrlHandler(originalFetch, (url) => {
        if (url.includes("storage.bunnycdn.com")) {
          // deno-lint-ignore no-explicit-any
          return Promise.resolve(new Response(encrypted as any));
        }
        return null;
      });
      await fn();
    });

  test("returns 404 when storage is not enabled", async () => {
    const { eventId, attendeeId } = await setupAttachment();
    const path = await signUrl(eventId, attendeeId);
    const response = await handleRequest(mockRequest(path));
    expect(response.status).toBe(404);
  });

  test("returns 403 when query params are missing", async () => {
    enableStorage();
    const response = await handleRequest(mockRequest("/attachment/1"));
    expect(response.status).toBe(403);
  });

  test("returns 403 when attendee ID is not a number", async () => {
    enableStorage();
    const response = await handleRequest(
      mockRequest("/attachment/1?a=abc&exp=123&sig=test"),
    );
    expect(response.status).toBe(403);
  });

  test("returns 403 when signature is invalid", async () => {
    enableStorage();
    const { eventId, attendeeId } = await setupAttachment();
    const response = await handleRequest(
      mockRequest(
        `/attachment/${eventId}?a=${attendeeId}&exp=9999999999&sig=invalidsig`,
      ),
    );
    expect(response.status).toBe(403);
  });

  test("returns 404 when event has no attachment", async () => {
    enableStorage();
    const { event, attendee } = await createTestAttendeeWithToken(
      "No Attach",
      "noattach@example.com",
    );
    const path = await signUrl(event.id, attendee.id);
    const response = await handleRequest(mockRequest(path));
    expect(response.status).toBe(404);
  });

  test("returns 403 when attendee does not belong to event", async () => {
    enableStorage();
    const { eventId } = await setupAttachment();
    // Create a second attendee on a different event
    const { attendee: otherAttendee } = await createTestAttendeeWithToken(
      "Other User",
      "other@example.com",
    );
    // Sign with the first event but the other attendee
    const path = await signUrl(eventId, otherAttendee.id);
    const response = await handleRequest(mockRequest(path));
    expect(response.status).toBe(403);
  });

  test("serves decrypted file with correct Content-Type and Content-Disposition", async () => {
    enableStorage();
    const { eventId, attendeeId } = await setupAttachment();
    const path = await signUrl(eventId, attendeeId);
    const fileContent = new TextEncoder().encode("hello pdf content");

    await withCdnMock(fileContent, async () => {
      const response = await handleRequest(mockRequest(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="guide.pdf"',
      );
      const body = new Uint8Array(await response.arrayBuffer());
      expect(body).toEqual(fileContent);
    });
  });

  test("increments attachment_downloads counter", async () => {
    enableStorage();
    const { eventId, attendeeId } = await setupAttachment();
    const path = await signUrl(eventId, attendeeId);
    const fileContent = new TextEncoder().encode("data");

    const before = await getAttendeeRaw(attendeeId);
    expect(before!.attachment_downloads).toBe(0);

    await withCdnMock(fileContent, async () => {
      await handleRequest(mockRequest(path));
    });

    const after = await getAttendeeRaw(attendeeId);
    expect(after!.attachment_downloads).toBe(1);
  });

  test("returns 404 when CDN download fails", async () => {
    enableStorage();
    const { eventId, attendeeId } = await setupAttachment();
    const path = await signUrl(eventId, attendeeId);

    await withFetchMock(async (originalFetch) => {
      installUrlHandler(originalFetch, (url) => {
        if (url.includes("storage.bunnycdn.com")) {
          return Promise.resolve(new Response("Not Found", { status: 404 }));
        }
        return null;
      });
      const response = await handleRequest(mockRequest(path));
      expect(response.status).toBe(404);
    });
  });

  test("returns no-store cache control", async () => {
    enableStorage();
    const { eventId, attendeeId } = await setupAttachment();
    const path = await signUrl(eventId, attendeeId);
    const fileContent = new TextEncoder().encode("data");

    await withCdnMock(fileContent, async () => {
      const response = await handleRequest(mockRequest(path));
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
  });
});
