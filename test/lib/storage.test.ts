import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { decryptBytes, encryptBytes } from "#shared/crypto/encryption.ts";
import { FULL_IMAGE_TARGET } from "#shared/images/targets.ts";
import { MAX_IMAGE_SIZE } from "#shared/limits.ts";
import {
  ATTACHMENT_ERROR_MESSAGES,
  deleteAllImageStorageFiles,
  deleteAllListingAttachmentFiles,
  deleteFile,
  detectImageType,
  downloadImage,
  downloadRaw,
  generateAttachmentFilename,
  getImageProxyUrl,
  getMimeTypeFromFilename,
  isStorageEnabled,
  listFiles,
  listFilesWithMeta,
  MAX_ATTACHMENT_SIZE,
  runWithStorageConfig,
  uploadAttachment,
  uploadImageTargets,
  uploadRaw,
  validateAttachment,
  validateImage,
} from "#shared/storage.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  describeWithEnv,
  expectWebpContainer,
  makeTestPng,
  withBunnyDeleteCapture,
  withBunnyStorageStub,
  withLocalStorageEnabled,
  withStorageDisabled,
} from "#test-utils";

describeWithEnv(
  "storage",
  {
    encryptionKey: true,
    env: {
      STORAGE_ZONE_KEY: undefined,
      STORAGE_ZONE_NAME: undefined,
    },
  },
  () => {
    describe("isStorageEnabled", () => {
      test("returns false when neither env var is set", async () => {
        await withStorageDisabled(() => {
          expect(isStorageEnabled()).toBe(false);
        });
      });

      test("returns false when only zoneName is set", () => {
        runWithStorageConfig(
          { localPath: "", zoneKey: "", zoneName: "myzone" },
          () => {
            expect(isStorageEnabled()).toBe(false);
          },
        );
      });

      test("returns false when only zoneKey is set", () => {
        runWithStorageConfig(
          { localPath: "", zoneKey: "mykey", zoneName: "" },
          () => {
            expect(isStorageEnabled()).toBe(false);
          },
        );
      });

      test("returns true when Bunny credentials are set", () => {
        runWithStorageConfig({ zoneKey: "mykey", zoneName: "myzone" }, () => {
          expect(isStorageEnabled()).toBe(true);
        });
      });

      test("returns true when LOCAL_STORAGE_PATH is set", async () => {
        await withLocalStorageEnabled(async () => {
          await Promise.resolve();
          expect(isStorageEnabled()).toBe(true);
        });
      });
    });

    describe("deleteFile", () => {
      test("throws when storage is not configured", async () => {
        await withStorageDisabled(async () => {
          await expect(deleteFile("test.jpg")).rejects.toThrow(
            "Storage is not configured",
          );
        });
      });

      test("throws the configured override error before touching storage", async () => {
        await withLocalStorageEnabled(async () => {
          setDeleteOverride(new Error("forced delete failure"));
          try {
            await expect(deleteFile("any-file.jpg")).rejects.toThrow(
              "forced delete failure",
            );
          } finally {
            setDeleteOverride(null);
          }
        });
      });
    });

    describe("local filesystem storage", () => {
      test("uploadImageTargets transcodes to an encrypted WebP file", async () => {
        await withLocalStorageEnabled(async (dir) => {
          const png = await makeTestPng(120, 90);
          const [filename] = await uploadImageTargets(png, "image/png", [
            FULL_IMAGE_TARGET,
          ]);
          // Every stored variant is WebP, regardless of the source format.
          expect(filename).toMatch(/^[0-9a-f-]+\.webp$/);
          const stat = await Deno.stat(`${dir}/${filename}`);
          expect(stat.isFile).toBe(true);
          expect(stat.size).toBeGreaterThan(0);
        });
      });

      test("downloadImage decrypts a stored WebP variant", async () => {
        await withLocalStorageEnabled(async () => {
          const png = await makeTestPng(120, 90);
          const [filename] = await uploadImageTargets(png, "image/png", [
            FULL_IMAGE_TARGET,
          ]);
          const result = await downloadImage(filename as string);
          expect(result).not.toBeNull();
          expectWebpContainer(result as Uint8Array);
        });
      });

      test("downloadImage returns null for missing file", async () => {
        await withLocalStorageEnabled(async () => {
          const result = await downloadImage("nonexistent.webp");
          expect(result).toBeNull();
        });
      });

      test("deleteFile removes a stored WebP variant", async () => {
        await withLocalStorageEnabled(async (dir) => {
          const png = await makeTestPng(64, 48);
          const [filename] = await uploadImageTargets(png, "image/png", [
            FULL_IMAGE_TARGET,
          ]);
          await deleteFile(filename as string);
          await expect(Deno.stat(`${dir}/${filename}`)).rejects.toBeInstanceOf(
            Deno.errors.NotFound,
          );
        });
      });

      test("uploadAttachment stores any file type", async () => {
        await withLocalStorageEnabled(async (dir) => {
          const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01]);
          const filename = generateAttachmentFilename("report.pdf");
          await uploadAttachment(pdfBytes, filename);
          const stat = await Deno.stat(`${dir}/${filename}`);
          expect(stat.isFile).toBe(true);
        });
      });

      test("downloadImage rethrows unexpected filesystem errors", async () => {
        await withLocalStorageEnabled(async (dir) => {
          // A directory at the expected file path causes a non-NotFound read error
          const filename = "collision.jpg";
          await Deno.mkdir(`${dir}/${filename}`);
          await expect(downloadImage(filename)).rejects.toBeInstanceOf(Error);
        });
      });

      test("uploadRaw stores bytes without encryption", async () => {
        await withLocalStorageEnabled(async (dir) => {
          const data = new TextEncoder().encode("hello raw");
          await uploadRaw(data, "raw-test.txt");
          const stored = await Deno.readFile(`${dir}/raw-test.txt`);
          // Raw bytes should match exactly (no encryption overhead)
          expect(stored).toEqual(data);
        });
      });

      test("downloadRaw reads bytes without decryption", async () => {
        await withLocalStorageEnabled(async () => {
          const data = new TextEncoder().encode("raw roundtrip");
          await uploadRaw(data, "raw-dl.txt");
          const result = await downloadRaw("raw-dl.txt");
          expect(result).toEqual(data);
        });
      });

      test("downloadRaw returns null for missing file", async () => {
        await withLocalStorageEnabled(async () => {
          const result = await downloadRaw("nonexistent.txt");
          expect(result).toBeNull();
        });
      });

      test("listFiles returns files matching prefix", async () => {
        await withLocalStorageEnabled(async () => {
          await uploadRaw(new Uint8Array(0), "backup-a.zip");
          await uploadRaw(new Uint8Array(0), "backup-b.zip");
          await uploadRaw(new Uint8Array(0), "other-file.txt");
          const files = await listFiles("backup-");
          expect(files).toEqual(["backup-a.zip", "backup-b.zip"]);
        });
      });

      test("listFiles returns empty array when no files match", async () => {
        await withLocalStorageEnabled(async () => {
          const files = await listFiles("nonexistent-");
          expect(files).toEqual([]);
        });
      });

      test("listFiles returns empty array when directory does not exist", async () => {
        await runWithStorageConfig(
          {
            localPath: `/tmp/nonexistent-dir-${crypto.randomUUID()}`,
            zoneKey: "",
            zoneName: "",
          },
          async () => {
            const files = await listFiles("backup-");
            expect(files).toEqual([]);
          },
        );
      });

      test("listFiles skips directory entries", async () => {
        await withLocalStorageEnabled(async (dir) => {
          await uploadRaw(new Uint8Array(0), "backup-a.zip");
          await Deno.mkdir(`${dir}/backup-subdir`);
          const files = await listFiles("backup-");
          expect(files).toEqual(["backup-a.zip"]);
        });
      });

      test("listFilesWithMeta returns each file's byte size", async () => {
        await withLocalStorageEnabled(async () => {
          await uploadRaw(new Uint8Array(3), "backup-a.zip");
          await uploadRaw(new Uint8Array(7), "backup-b.zip");
          const files = await listFilesWithMeta("backup-");
          expect(files).toEqual([
            { name: "backup-a.zip", size: 3 },
            { name: "backup-b.zip", size: 7 },
          ]);
        });
      });

      test("lists a subfolder, returning names that include the folder", async () => {
        await withLocalStorageEnabled(async () => {
          // uploadRaw creates the nested folder on demand.
          await uploadRaw(new Uint8Array(0), "acme/backup-a.zip");
          await uploadRaw(new Uint8Array(0), "acme/backup-b.zip");
          const files = await listFiles("acme/");
          expect(files).toEqual(["acme/backup-a.zip", "acme/backup-b.zip"]);
        });
      });

      test("a folder listing filters by the leaf name after the slash", async () => {
        await withLocalStorageEnabled(async () => {
          await uploadRaw(new Uint8Array(0), "acme/backup-a.zip");
          await uploadRaw(new Uint8Array(0), "acme/notes.txt");
          const files = await listFiles("acme/backup-");
          expect(files).toEqual(["acme/backup-a.zip"]);
        });
      });

      test("a folder named like a prefix of another stays separate", async () => {
        await withLocalStorageEnabled(async () => {
          await uploadRaw(new Uint8Array(0), "tickets/backup-a.zip");
          await uploadRaw(new Uint8Array(0), "tickets-spencer/backup-b.zip");
          // Listing "tickets/" must not leak "tickets-spencer/"'s file even
          // though "tickets" is a string prefix of "tickets-spencer".
          expect(await listFiles("tickets/")).toEqual(["tickets/backup-a.zip"]);
          expect(await listFiles("tickets-spencer/")).toEqual([
            "tickets-spencer/backup-b.zip",
          ]);
        });
      });

      test("a root listing does not descend into subfolders", async () => {
        await withLocalStorageEnabled(async () => {
          await uploadRaw(new Uint8Array(0), "root-file.zip");
          await uploadRaw(new Uint8Array(0), "acme/backup-a.zip");
          // Only the root-level file; the subfolder's contents are not listed.
          expect(await listFiles("")).toEqual(["root-file.zip"]);
        });
      });
    });

    describe("getImageProxyUrl", () => {
      test("returns proxy path for filename", () => {
        expect(getImageProxyUrl("abc123.jpg")).toBe("/image/abc123.jpg");
      });
    });

    describe("getMimeTypeFromFilename", () => {
      test("returns MIME type for .jpg", () => {
        expect(getMimeTypeFromFilename("abc.jpg")).toBe("image/jpeg");
      });

      test("returns MIME type for .png", () => {
        expect(getMimeTypeFromFilename("abc.png")).toBe("image/png");
      });

      test("returns MIME type for .gif", () => {
        expect(getMimeTypeFromFilename("abc.gif")).toBe("image/gif");
      });

      test("returns MIME type for .webp", () => {
        expect(getMimeTypeFromFilename("abc.webp")).toBe("image/webp");
      });

      test("returns null for unknown extension", () => {
        expect(getMimeTypeFromFilename("abc.bmp")).toBeNull();
      });

      test("returns null for no extension", () => {
        expect(getMimeTypeFromFilename("abc")).toBeNull();
      });
    });

    describe("detectImageType", () => {
      test("detects JPEG from magic bytes", () => {
        const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
        expect(detectImageType(data)).toBe("image/jpeg");
      });

      test("detects PNG from magic bytes", () => {
        const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
        expect(detectImageType(data)).toBe("image/png");
      });

      test("detects GIF from magic bytes", () => {
        const data = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]);
        expect(detectImageType(data)).toBe("image/gif");
      });

      test("detects WebP from magic bytes", () => {
        const data = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00]);
        expect(detectImageType(data)).toBe("image/webp");
      });

      test("returns null for unknown bytes", () => {
        const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        expect(detectImageType(data)).toBeNull();
      });

      test("returns null for empty data", () => {
        const data = new Uint8Array([]);
        expect(detectImageType(data)).toBeNull();
      });
    });

    describe("validateImage", () => {
      const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

      test("accepts valid JPEG image", () => {
        const result = validateImage(jpegHeader, "image/jpeg");
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.detectedType).toBe("image/jpeg");
        }
      });

      test("accepts valid PNG image", () => {
        const result = validateImage(pngHeader, "image/png");
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.detectedType).toBe("image/png");
        }
      });

      test("rejects image exceeding size limit", () => {
        const largeData = new Uint8Array(MAX_IMAGE_SIZE + 1);
        largeData[0] = 0xff;
        largeData[1] = 0xd8;
        largeData[2] = 0xff;
        const result = validateImage(largeData, "image/jpeg");
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toBe("too_large");
        }
      });

      test("rejects disallowed MIME type", () => {
        const result = validateImage(jpegHeader, "application/pdf");
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toBe("invalid_type");
        }
      });

      test("rejects file with valid MIME but invalid magic bytes", () => {
        const fakeData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        const result = validateImage(fakeData, "image/jpeg");
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toBe("invalid_content");
        }
      });

      test("accepts image exactly at size limit", () => {
        const data = new Uint8Array(MAX_IMAGE_SIZE);
        data[0] = 0xff;
        data[1] = 0xd8;
        data[2] = 0xff;
        const result = validateImage(data, "image/jpeg");
        expect(result.valid).toBe(true);
      });
    });

    describe("allowed image types", () => {
      test("accepts the three uploadable types", () => {
        expect(
          validateImage(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg").valid,
        ).toBe(true);
        expect(
          validateImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")
            .valid,
        ).toBe(true);
        expect(
          validateImage(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "image/webp")
            .valid,
        ).toBe(true);
      });

      test("rejects GIF uploads (would lose animation once transcoded)", () => {
        const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
        const result = validateImage(gif, "image/gif");
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.error).toBe("invalid_type");
      });

      test("rejects a GIF disguised with an uploadable MIME type", () => {
        // Declared PNG, but the magic bytes are GIF — sniffed content is not
        // uploadable, so it is rejected as invalid content.
        const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
        const result = validateImage(gif, "image/png");
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.error).toBe("invalid_content");
      });

      test("rejects unsupported types", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
        expect(validateImage(jpeg, "image/svg+xml").valid).toBe(false);
        expect(validateImage(jpeg, "application/pdf").valid).toBe(false);
      });
    });

    describe("validateAttachment", () => {
      test("accepts file under 25MB", () => {
        const data = new Uint8Array(1024);
        const result = validateAttachment(data);
        expect(result.valid).toBe(true);
      });

      test("accepts file exactly at 25MB limit", () => {
        const data = new Uint8Array(MAX_ATTACHMENT_SIZE);
        const result = validateAttachment(data);
        expect(result.valid).toBe(true);
      });

      test("rejects file exceeding 25MB", () => {
        const data = new Uint8Array(MAX_ATTACHMENT_SIZE + 1);
        const result = validateAttachment(data);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toBe("too_large");
        }
      });

      test("accepts any file type (not just images)", () => {
        // PDF magic bytes - not a valid image, but attachments accept any type
        const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        const result = validateAttachment(data);
        expect(result.valid).toBe(true);
      });
    });

    describe("ATTACHMENT_ERROR_MESSAGES", () => {
      test("has message for too_large error", () => {
        expect(ATTACHMENT_ERROR_MESSAGES.too_large).toBe(
          "Attachment exceeds the 25MB size limit",
        );
      });
    });

    describe("generateAttachmentFilename", () => {
      test("generates filename with UUID prefix and original name", () => {
        const filename = generateAttachmentFilename("report.pdf");
        // The prefix is a real UUID (from crypto.randomUUID), validated with
        // valibot's uuid() rather than a hand-rolled hex regex; the sanitized
        // original name follows it.
        expect(v.is(v.pipe(v.string(), v.uuid()), filename.slice(0, 36))).toBe(
          true,
        );
        expect(filename.slice(36)).toBe("-report.pdf");
      });

      test("sanitizes special characters in filename", () => {
        const filename = generateAttachmentFilename("my file (1).pdf");
        // Spaces and parens should be replaced with underscores
        expect(filename).toMatch(/-my_file__1_\.pdf$/);
      });

      test("handles path separators in filename", () => {
        const filename = generateAttachmentFilename("/path/to/file.txt");
        // Only the basename should remain
        expect(filename).toMatch(/-file\.txt$/);
        expect(filename).not.toContain("/path");
      });

      test("handles backslash path separators", () => {
        const filename = generateAttachmentFilename(
          "C:\\Users\\docs\\file.txt",
        );
        expect(filename).toMatch(/-file\.txt$/);
        expect(filename).not.toContain("Users");
      });

      test("falls back to 'file' when basename is empty", () => {
        const filename = generateAttachmentFilename("/");
        expect(filename).toMatch(/-file$/);
      });

      test("generates unique filenames for same input", () => {
        const a = generateAttachmentFilename("doc.pdf");
        const b = generateAttachmentFilename("doc.pdf");
        expect(a).not.toBe(b);
      });

      test("preserves file extension", () => {
        const filename = generateAttachmentFilename("archive.tar.gz");
        expect(filename).toMatch(/\.tar\.gz$/);
      });
    });

    describeWithEnv(
      "deleteAllListingAttachmentFiles",
      {
        env: {
          STORAGE_ZONE_KEY: "testkey",
          STORAGE_ZONE_NAME: "testzone",
        },
      },
      () => {
        test("deletes attachments for all listings", async () => {
          const listings = [
            {
              attachment_url: "att1.pdf",
              id: 1,
            },
            {
              attachment_url: "",
              id: 2,
            },
            {
              attachment_url: "att3.pdf",
              id: 3,
            },
          ];

          await withBunnyDeleteCapture(async (deletedUrls) => {
            await deleteAllListingAttachmentFiles(listings);

            expect(deletedUrls.some((u) => u.includes("att1.pdf"))).toBe(true);
            expect(deletedUrls.some((u) => u.includes("att3.pdf"))).toBe(true);
            // Empty URLs should not trigger delete calls.
            expect(deletedUrls).toHaveLength(2);
          });
        });

        test("skips listings with no attachment", async () => {
          const listings = [{ attachment_url: "", id: 1 }];

          await withBunnyDeleteCapture(
            async (deletedUrls) => {
              await deleteAllListingAttachmentFiles(listings);
              expect(deletedUrls).toHaveLength(0);
            },
            { withConfig: false },
          );
        });

        test("handles empty listings array", async () => {
          await deleteAllListingAttachmentFiles([]);
        });

        test("continues deleting when individual file delete fails", async () => {
          const listings = [
            {
              attachment_url: "fail.pdf",
              id: 1,
            },
            {
              attachment_url: "succeed.pdf",
              id: 2,
            },
          ];

          await withBunnyDeleteCapture(
            async (deletedUrls) => {
              await deleteAllListingAttachmentFiles(listings);
              expect(deletedUrls.some((u) => u.includes("succeed.pdf"))).toBe(
                true,
              );
            },
            {
              extraHandler: (url) =>
                url.includes("fail.pdf")
                  ? Promise.reject(new Error("CDN error"))
                  : null,
            },
          );
        });

        test("deletes image files and thumbnails for all images", async () => {
          const images = [
            {
              filename: nonEmptyString("img1.webp"),
              filename_thumb: nonEmptyString("img1-thumb.webp"),
              id: 1,
            },
            {
              filename: nonEmptyString("img2.webp"),
              filename_thumb: nonEmptyString("img2-thumb.webp"),
              id: 2,
            },
          ];

          await withBunnyDeleteCapture(async (deletedUrls) => {
            await deleteAllImageStorageFiles(images);

            expect(deletedUrls.some((u) => u.includes("img1.webp"))).toBe(true);
            expect(deletedUrls.some((u) => u.includes("img1-thumb.webp"))).toBe(
              true,
            );
            expect(deletedUrls.some((u) => u.includes("img2.webp"))).toBe(true);
            expect(deletedUrls.some((u) => u.includes("img2-thumb.webp"))).toBe(
              true,
            );
            expect(deletedUrls).toHaveLength(4);
          });
        });
      },
    );

    describeWithEnv(
      "Bunny CDN raw operations",
      {
        env: {
          STORAGE_ZONE_KEY: "testkey",
          STORAGE_ZONE_NAME: "testzone",
        },
      },
      () => {
        test("uploadRaw uploads bytes to Bunny CDN", async () => {
          const uploadRequests: Array<{
            body: Uint8Array;
            contentType: string | null;
            method: string;
            url: string;
          }> = [];
          await withBunnyStorageStub(
            async (url, init) => {
              const request = new Request(url, init);
              uploadRequests.push({
                body: new Uint8Array(await request.arrayBuffer()),
                contentType: request.headers.get("content-type"),
                method: request.method,
                url,
              });
              return new Response(JSON.stringify({ HttpCode: 201 }), {
                status: 201,
              });
            },
            async () => {
              const raw = new Uint8Array([1, 2, 3, 4]);
              const filename = await uploadRaw(raw, "raw-upload.bin");

              expect(filename).toBe("raw-upload.bin");
              expect(uploadRequests).toHaveLength(1);
              const uploadRequest = uploadRequests[0];
              if (uploadRequest === undefined) {
                throw new Error("Expected upload request to be captured");
              }
              expect(uploadRequest.method).toBe("PUT");
              expect(uploadRequest.url).toContain("/raw-upload.bin");
              expect(uploadRequest.contentType).toBe(
                "application/octet-stream",
              );
              expect(uploadRequest.body).toEqual(raw);
            },
          );
        });

        test("downloadRaw returns null when Bunny reports missing file", async () => {
          await withBunnyStorageStub(
            () => new Response("File not found", { status: 404 }),
            async () => {
              await expect(downloadRaw("missing.bin")).resolves.toBeNull();
            },
          );
        });

        test("listFiles lists files from Bunny CDN matching prefix", async () => {
          await withBunnyStorageStub(
            () =>
              new Response(
                JSON.stringify([
                  { ObjectName: "backup-2024.zip" },
                  { ObjectName: "backup-2025.zip" },
                  { ObjectName: "other-file.txt" },
                  {},
                ]),
                { status: 200 },
              ),
            async () => {
              const files = await listFiles("backup-");
              expect(files).toEqual(["backup-2024.zip", "backup-2025.zip"]);
            },
          );
        });

        test("listFiles requests a subfolder URL and prefixes returned names", async () => {
          let listedUrl = "";
          await withBunnyStorageStub(
            (url) => {
              listedUrl = url;
              // Bunny returns leaf names within the requested folder.
              return Response.json([{ ObjectName: "backup-2024.zip" }]);
            },
            async () => {
              const files = await listFiles("acme/");

              // The folder is part of the request path, not a name filter…
              expect(listedUrl).toContain("/testzone/acme/");
              // …and returned names carry the folder so callers can act on them.
              expect(files).toEqual(["acme/backup-2024.zip"]);
            },
          );
        });

        test("treats a missing folder (404) as empty", async () => {
          await withBunnyStorageStub(
            () => new Response("Not Found", { status: 404 }),
            async () => {
              // A brand-new site's backup folder doesn't exist yet, so the
              // listing must resolve to [] rather than throwing.
              expect(await listFiles("newsite/")).toEqual([]);
            },
          );
        });

        test("surfaces a non-404 listing failure instead of reporting empty", async () => {
          await withBunnyStorageStub(
            () => new Response("Server Error", { status: 500 }),
            async () => {
              // A 5xx/auth error must not masquerade as "no files" — it would
              // make the gate report "no backup" when backups exist.
              await expect(listFiles("acme/")).rejects.toThrow();
            },
          );
        });

        test("excludes directory entries from the listing", async () => {
          await withBunnyStorageStub(
            () =>
              Response.json([
                { IsDirectory: true, ObjectName: "tickets" },
                { IsDirectory: false, ObjectName: "restore-pending-x.zip" },
              ]),
            async () => {
              // The per-site folder entry must not come back as a file.
              expect(await listFiles("")).toEqual(["restore-pending-x.zip"]);
            },
          );
        });

        test("listFilesWithMeta reads file size from the Length field, defaulting to 0", async () => {
          await withBunnyStorageStub(
            () =>
              new Response(
                JSON.stringify([
                  { Length: 1024, ObjectName: "backup-2024.zip" },
                  // No Length field — should default to 0.
                  { ObjectName: "backup-2025.zip" },
                  { Length: 5, ObjectName: "other-file.txt" },
                ]),
                { status: 200 },
              ),
            async () => {
              const files = await listFilesWithMeta("backup-");
              expect(files).toEqual([
                { name: "backup-2024.zip", size: 1024 },
                { name: "backup-2025.zip", size: 0 },
              ]);
            },
          );
        });
      },
    );

    describe("encryptBytes / decryptBytes", () => {
      test("round-trips binary data through encrypt then decrypt", async () => {
        const original = new Uint8Array([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
        ]);
        const encrypted = await encryptBytes(original);
        // Encrypted data should be larger (12 byte IV + 16 byte auth tag)
        expect(encrypted.byteLength).toBeGreaterThan(original.byteLength);
        // Encrypted data should not start with original magic bytes
        expect(encrypted[0]).not.toBe(0xff);
        const decrypted = await decryptBytes(encrypted);
        expect(decrypted).toEqual(original);
      });

      test("produces different ciphertext for same input", async () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const a = await encryptBytes(data);
        const b = await encryptBytes(data);
        // Different IVs mean different ciphertext
        expect(a).not.toEqual(b);
        // But both decrypt to the same value
        expect(await decryptBytes(a)).toEqual(data);
        expect(await decryptBytes(b)).toEqual(data);
      });

      test("round-trips data larger than the node threshold (Web Crypto path)", async () => {
        // > 64 KB routes through the Web Crypto branch instead of node:crypto
        const original = new Uint8Array(70_000);
        for (let i = 0; i < original.length; i++) original[i] = (i * 31) & 0xff;
        const encrypted = await encryptBytes(original);
        const decrypted = await decryptBytes(encrypted);
        expect(decrypted).toEqual(original);
      });

      test("throws on invalid binary format", async () => {
        const invalidData = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01]);
        await expect(decryptBytes(invalidData)).rejects.toThrow(
          "Invalid binary encryption format",
        );
      });

      test("throws on unsupported binary version", async () => {
        // Valid ENCB magic but wrong version (0xFF instead of 0x01)
        const data = new Uint8Array(17); // BINARY_HEADER_SIZE = 17
        data.set([0x45, 0x4e, 0x43, 0x42], 0); // "ENCB" magic
        data[4] = 0xff; // Invalid version
        await expect(decryptBytes(data)).rejects.toThrow(
          "Unsupported binary encryption version: 255",
        );
      });
    });
  },
);
