import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getMimeType } from "#routes/attachments.ts";
import { signAttachmentUrl } from "#shared/attachment-url.ts";
import { encryptBytes } from "#shared/crypto/encryption.ts";
import { getAttendeeRaw } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import {
  createTestAttendeeWithToken,
  describeWithEnv,
  installUrlHandler,
  mockRequest,
  withFetchMock,
  withStorageDisabled,
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
    expect(getMimeType("file.unknownext")).toBe("application/octet-stream");
  });

  test("returns application/octet-stream for no extension", () => {
    expect(getMimeType("noextension")).toBe("application/octet-stream");
  });

  test("handles uppercase extensions", () => {
    expect(getMimeType("FILE.PDF")).toBe("application/pdf");
    expect(getMimeType("PHOTO.JPG")).toBe("image/jpeg");
  });
});

describeWithEnv(
  "GET /attachment/:id",
  {
    db: true,
    encryptionKey: true,
    env: {
      STORAGE_ZONE_KEY: undefined,
      STORAGE_ZONE_NAME: undefined,
    },
  },
  () => {
    /** Create an listing+attendee with an attachment configured */
    const setupAttachment = async () => {
      const { listing, attendee } = await createTestAttendeeWithToken(
        "Test User",
        "test@example.com",
      );
      await listingsTable.update(listing.id, {
        attachmentName: "guide.pdf",
        attachmentUrl: "file.pdf",
      });
      return { attendeeId: attendee.id, listingId: listing.id };
    };

    /** Create an listing+attendee with a custom attachment name */
    const setupAttachmentWithName = async (attachmentName: string) => {
      const { listing, attendee } = await createTestAttendeeWithToken(
        "Test User",
        "test@example.com",
      );
      await listingsTable.update(listing.id, {
        attachmentName,
        attachmentUrl: "file.pdf",
      });
      return { attendeeId: attendee.id, listingId: listing.id };
    };

    /** Sign a URL and return the full path with query params */
    const signUrl = async (
      listingId: number,
      attendeeId: number,
    ): Promise<string> => {
      return await signAttachmentUrl(listingId, attendeeId);
    };

    /** Mock CDN fetch to return encrypted data with isolated storage config */
    const withCdnMock = (
      data: Uint8Array,
      fn: () => Promise<void>,
    ): Promise<void> =>
      runWithStorageConfig({ zoneKey: "testkey", zoneName: "testzone" }, () =>
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
        }),
      );

    /** Sign the attachment URL for a setup, serve "data" from the mocked CDN,
     * and return the GET response. */
    const fetchAttachment = async (setup: {
      listingId: number;
      attendeeId: number;
    }): Promise<Response> => {
      const path = await signUrl(setup.listingId, setup.attendeeId);
      let response!: Response;
      await withCdnMock(new TextEncoder().encode("data"), async () => {
        response = await handleRequest(mockRequest(path));
      });
      return response;
    };

    test("returns 404 when storage is not enabled", async () => {
      await withStorageDisabled(async () => {
        const { listingId, attendeeId } = await setupAttachment();
        const path = await signUrl(listingId, attendeeId);
        const response = await handleRequest(mockRequest(path));
        expect(response.status).toBe(404);
      });
    });

    /** Shorthand for running a test body with storage enabled */
    const withStorage = <T>(fn: () => T): T =>
      runWithStorageConfig({ zoneKey: "testkey", zoneName: "testzone" }, fn);

    test("returns 403 when query params are missing", async () => {
      await withStorage(async () => {
        const response = await handleRequest(mockRequest("/attachment/1"));
        expect(response.status).toBe(403);
      });
    });

    test("returns 403 when attendee ID is not a number", async () => {
      await withStorage(async () => {
        const response = await handleRequest(
          mockRequest("/attachment/1?a=abc&exp=123&sig=test"),
        );
        expect(response.status).toBe(403);
      });
    });

    test("returns 403 when signature is invalid", async () => {
      await withStorage(async () => {
        const { listingId, attendeeId } = await setupAttachment();
        const response = await handleRequest(
          mockRequest(
            `/attachment/${listingId}?a=${attendeeId}&exp=9999999999&sig=invalidsig`,
          ),
        );
        expect(response.status).toBe(403);
      });
    });

    test("returns 404 when listing has no attachment", async () => {
      await withStorage(async () => {
        const { listing, attendee } = await createTestAttendeeWithToken(
          "No Attach",
          "noattach@example.com",
        );
        const path = await signUrl(listing.id, attendee.id);
        const response = await handleRequest(mockRequest(path));
        expect(response.status).toBe(404);
      });
    });

    test("returns 403 when attendee does not belong to listing", async () => {
      await withStorage(async () => {
        const { listingId } = await setupAttachment();
        // Create a second attendee on a different listing
        const { attendee: otherAttendee } = await createTestAttendeeWithToken(
          "Other User",
          "other@example.com",
        );
        // Sign with the first listing but the other attendee
        const path = await signUrl(listingId, otherAttendee.id);
        const response = await handleRequest(mockRequest(path));
        expect(response.status).toBe(403);
      });
    });

    test("returns 403 when the booking line is marked no-quantity", async () => {
      await withStorage(async () => {
        const { listingId, attendeeId } = await setupAttachment();
        // A still-valid signed URL must stop working once the line is a
        // quantity-0 sentinel — the protected attachment is no longer theirs.
        await getDb().execute({
          args: [attendeeId, listingId],
          sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ? AND listing_id = ?",
        });
        const path = await signUrl(listingId, attendeeId);
        const response = await handleRequest(mockRequest(path));
        expect(response.status).toBe(403);
      });
    });

    test("serves decrypted file with correct Content-Type and Content-Disposition", async () => {
      const { listingId, attendeeId } = await setupAttachment();
      const path = await signUrl(listingId, attendeeId);
      const fileContent = new TextEncoder().encode("hello pdf content");

      await withCdnMock(fileContent, async () => {
        const response = await handleRequest(mockRequest(path));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/pdf");
        expect(response.headers.get("content-disposition")).toBe(
          "attachment; filename=\"guide.pdf\"; filename*=UTF-8''guide.pdf",
        );
        const body = new Uint8Array(await response.arrayBuffer());
        expect(body).toEqual(fileContent);
      });
    });

    const sanitizationCases: Array<{
      label: string;
      name: string;
      notContains: string[];
      contains?: string;
      equals?: string;
    }> = [
      {
        label: "strips CR/LF header injection",
        name: 'evil"\r\nx-bad: 1.pdf',
        notContains: ["\r", "\n", "x-bad:"],
      },
      {
        label: "strips quote injection to prevent extra filename",
        name: 'report.pdf"; filename="evil.html',
        notContains: ['filename="evil.html"'],
      },
      {
        contains: "secret.pdf",
        label: "strips path traversal, preserves basename",
        name: "../../secret.pdf",
        notContains: ["../"],
      },
      {
        label: "strips semicolon injection",
        name: "report;evil.pdf",
        notContains: [";evil"],
      },
      {
        equals: "attachment; filename=\"file\"; filename*=UTF-8''%01%02",
        label: "falls back to 'file' for control-only names",
        name: "\x01\x02",
        notContains: [],
      },
      {
        equals:
          "attachment; filename=\".pdf\"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.pdf",
        label: "preserves non-ASCII via filename* (Chinese)",
        name: "報告.pdf",
        notContains: [],
      },
      {
        equals:
          "attachment; filename=\".pdf\"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf",
        label: "preserves non-ASCII via filename* (Cyrillic)",
        name: "отчёт.pdf",
        notContains: [],
      },
      {
        equals: "attachment; filename=\"file\"; filename*=UTF-8''file",
        label:
          "falls back to 'file' in both filename and filename* for empty basename",
        name: "",
        notContains: [],
      },
    ];

    for (const {
      label,
      name,
      notContains,
      contains,
      equals,
    } of sanitizationCases) {
      test(`sanitizes attachment filename: ${label}`, async () => {
        const setup = await setupAttachmentWithName(name);
        const response = await fetchAttachment(setup);
        expect(response.status).toBe(200);
        const cd = response.headers.get("content-disposition")!;
        for (const bad of notContains) expect(cd).not.toContain(bad);
        if (contains) expect(cd).toContain(contains);
        if (equals) expect(cd).toBe(equals);

        // Verify no duplicate Content-Disposition headers from injection
        const cdHeaders = [...response.headers.entries()].filter(
          ([k]) => k.toLowerCase() === "content-disposition",
        );
        if (notContains.length > 0) expect(cdHeaders.length).toBe(1);
      });
    }

    test("increments attachment_downloads counter", async () => {
      const setup = await setupAttachment();
      const before = await getAttendeeRaw(setup.attendeeId);
      expect(before!.attachment_downloads).toBe(0);

      await fetchAttachment(setup);

      const after = await getAttendeeRaw(setup.attendeeId);
      expect(after!.attachment_downloads).toBe(1);
    });

    test("returns 404 when CDN download fails", async () => {
      const { listingId, attendeeId } = await setupAttachment();
      const path = await signUrl(listingId, attendeeId);

      await withStorage(() =>
        withFetchMock(async (originalFetch) => {
          installUrlHandler(originalFetch, (url) => {
            if (url.includes("storage.bunnycdn.com")) {
              return Promise.resolve(
                new Response("Not Found", { status: 404 }),
              );
            }
            return null;
          });
          const response = await handleRequest(mockRequest(path));
          expect(response.status).toBe(404);
        }),
      );
    });

    test("returns public cache control for CDN caching", async () => {
      const setup = await setupAttachment();
      const response = await fetchAttachment(setup);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=3600",
      );
    });
  },
);
