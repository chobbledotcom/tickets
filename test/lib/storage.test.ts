import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decryptBytes, encryptBytes } from "#lib/crypto/encryption.ts";
import {
  ATTACHMENT_ERROR_MESSAGES,
  deleteAllEventStorageFiles,
  deleteFile,
  detectImageType,
  downloadImage,
  downloadRaw,
  generateAttachmentFilename,
  generateImageFilename,
  getImageProxyUrl,
  getMimeTypeFromFilename,
  isStorageEnabled,
  listFiles,
  MAX_ATTACHMENT_SIZE,
  runWithStorageConfig,
  uploadAttachment,
  uploadImage,
  uploadRaw,
  validateAttachment,
  validateImage,
} from "#lib/storage.ts";
import {
  describeWithEnv,
  installUrlHandler,
  withFetchMock,
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
    });

    describe("local filesystem storage", () => {
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);

      test("uploadImage writes encrypted file to local dir", async () => {
        await withLocalStorageEnabled(async (dir) => {
          const filename = await uploadImage(jpegBytes, "image/jpeg");
          expect(filename).toMatch(/^[0-9a-f-]+\.jpg$/);
          const stat = await Deno.stat(`${dir}/${filename}`);
          expect(stat.isFile).toBe(true);
          // Encrypted bytes should be larger than original
          expect(stat.size).toBeGreaterThan(jpegBytes.byteLength);
        });
      });

      test("downloadImage reads and decrypts file from local dir", async () => {
        await withLocalStorageEnabled(async () => {
          const filename = await uploadImage(jpegBytes, "image/jpeg");
          const result = await downloadImage(filename);
          expect(result).toEqual(jpegBytes);
        });
      });

      test("downloadImage returns null for missing file", async () => {
        await withLocalStorageEnabled(async () => {
          const result = await downloadImage("nonexistent.jpg");
          expect(result).toBeNull();
        });
      });

      test("deleteFile removes file from local dir", async () => {
        await withLocalStorageEnabled(async (dir) => {
          const filename = await uploadImage(jpegBytes, "image/jpeg");
          await deleteFile(filename);
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
        const largeData = new Uint8Array(256 * 1024 + 1);
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
        const data = new Uint8Array(256 * 1024);
        data[0] = 0xff;
        data[1] = 0xd8;
        data[2] = 0xff;
        const result = validateImage(data, "image/jpeg");
        expect(result.valid).toBe(true);
      });
    });

    describe("generateImageFilename", () => {
      test("generates filename with .jpg extension for JPEG", () => {
        const filename = generateImageFilename("image/jpeg");
        expect(filename).toMatch(/^[0-9a-f-]+\.jpg$/);
      });

      test("generates filename with .png extension for PNG", () => {
        const filename = generateImageFilename("image/png");
        expect(filename).toMatch(/^[0-9a-f-]+\.png$/);
      });

      test("generates filename with .gif extension for GIF", () => {
        const filename = generateImageFilename("image/gif");
        expect(filename).toMatch(/^[0-9a-f-]+\.gif$/);
      });

      test("generates filename with .webp extension for WebP", () => {
        const filename = generateImageFilename("image/webp");
        expect(filename).toMatch(/^[0-9a-f-]+\.webp$/);
      });

      test("generates unique filenames", () => {
        const a = generateImageFilename("image/jpeg");
        const b = generateImageFilename("image/jpeg");
        expect(a).not.toBe(b);
      });
    });

    describe("allowed image types", () => {
      test("accepts the four supported types", () => {
        expect(
          validateImage(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg").valid,
        ).toBe(true);
        expect(
          validateImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")
            .valid,
        ).toBe(true);
        expect(
          validateImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]), "image/gif")
            .valid,
        ).toBe(true);
        expect(
          validateImage(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "image/webp")
            .valid,
        ).toBe(true);
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
        expect(filename).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-report\.pdf$/,
        );
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
      "deleteAllEventStorageFiles",
      {
        env: {
          STORAGE_ZONE_KEY: "testkey",
          STORAGE_ZONE_NAME: "testzone",
        },
      },
      () => {
        test("deletes images and attachments for all events", async () => {
          const events = [
            { attachment_url: "att1.pdf", id: 1, image_url: "img1.jpg" },
            { attachment_url: "", id: 2, image_url: "img2.png" },
            { attachment_url: "att3.pdf", id: 3, image_url: "" },
          ];

          await runWithStorageConfig(
            { zoneKey: "testkey", zoneName: "testzone" },
            () =>
              withFetchMock(async (originalFetch) => {
                const deletedUrls: string[] = [];
                installUrlHandler(originalFetch, (url) => {
                  if (url.includes("storage.bunnycdn.com")) {
                    deletedUrls.push(url);
                    return Promise.resolve(
                      new Response(JSON.stringify({ HttpCode: 200 }), {
                        status: 200,
                      }),
                    );
                  }
                  return null;
                });

                await deleteAllEventStorageFiles(events);

                expect(deletedUrls.some((u) => u.includes("img1.jpg"))).toBe(
                  true,
                );
                expect(deletedUrls.some((u) => u.includes("att1.pdf"))).toBe(
                  true,
                );
                expect(deletedUrls.some((u) => u.includes("img2.png"))).toBe(
                  true,
                );
                expect(deletedUrls.some((u) => u.includes("att3.pdf"))).toBe(
                  true,
                );
                // Empty URLs should not trigger delete calls
                expect(deletedUrls).toHaveLength(4);
              }),
          );
        });

        test("skips events with no image or attachment", async () => {
          const events = [{ attachment_url: "", id: 1, image_url: "" }];

          await withFetchMock(async (originalFetch) => {
            const deletedUrls: string[] = [];
            installUrlHandler(originalFetch, (url) => {
              if (url.includes("storage.bunnycdn.com")) {
                deletedUrls.push(url);
                return Promise.resolve(
                  new Response(JSON.stringify({ HttpCode: 200 }), {
                    status: 200,
                  }),
                );
              }
              return null;
            });

            await deleteAllEventStorageFiles(events);

            expect(deletedUrls).toHaveLength(0);
          });
        });

        test("handles empty events array", async () => {
          await deleteAllEventStorageFiles([]);
        });

        test("continues deleting when individual file delete fails", async () => {
          const events = [
            { attachment_url: "", id: 1, image_url: "fail.jpg" },
            { attachment_url: "", id: 2, image_url: "succeed.jpg" },
          ];

          await runWithStorageConfig(
            { zoneKey: "testkey", zoneName: "testzone" },
            () =>
              withFetchMock(async (originalFetch) => {
                const deletedUrls: string[] = [];
                installUrlHandler(originalFetch, (url) => {
                  if (url.includes("fail.jpg")) {
                    return Promise.reject(new Error("CDN error"));
                  }
                  if (url.includes("storage.bunnycdn.com")) {
                    deletedUrls.push(url);
                    return Promise.resolve(
                      new Response(JSON.stringify({ HttpCode: 200 }), {
                        status: 200,
                      }),
                    );
                  }
                  return null;
                });

                await deleteAllEventStorageFiles(events);

                expect(deletedUrls.some((u) => u.includes("succeed.jpg"))).toBe(
                  true,
                );
              }),
          );
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
        // uploadRaw and downloadRaw Bunny branches are covered indirectly:
        // existing tests call uploadImage/downloadImage which delegate to
        // uploadRaw/downloadRaw via encryptAndUpload/downloadImage wrappers.
        // Only listFiles is a wholly new Bunny codepath that needs direct testing.

        test("listFiles lists files from Bunny CDN matching prefix", async () => {
          await runWithStorageConfig(
            { zoneKey: "testkey", zoneName: "testzone" },
            () =>
              withFetchMock(async (originalFetch) => {
                installUrlHandler(originalFetch, (url) => {
                  if (url.includes("storage.bunnycdn.com")) {
                    return Promise.resolve(
                      new Response(
                        JSON.stringify([
                          { ObjectName: "backup-2024.zip" },
                          { ObjectName: "backup-2025.zip" },
                          { ObjectName: "other-file.txt" },
                          {},
                        ]),
                        { status: 200 },
                      ),
                    );
                  }
                  return null;
                });

                const files = await listFiles("backup-");
                expect(files).toEqual(["backup-2024.zip", "backup-2025.zip"]);
              }),
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
