import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encryptBytes } from "#crypto/encryption.ts";
import { handleRequest } from "#routes";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import {
  expectBrokenImageResponse,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { JPEG_HEADER } from "#test-utils/factories.ts";
import {
  mockRequest,
  withCdnProxy,
  withExpectedError,
  withStorageDisabled,
} from "#test-utils/mocks.ts";

/** Reusable proxy route test path */
const PROXY_PATH = "/image/abc123-def4-5678-9abc-def012345678";

/** Request the image proxy route */
const proxyRequest = (ext = "jpg"): Promise<Response> =>
  handleRequest(mockRequest(`${PROXY_PATH}.${ext}`));

describeWithEnv(
  "server images > proxy",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("GET /image/:filename (proxy route)", () => {
      const errors = setupErrorSpy();

      test("serves decrypted image with correct content type", async () => {
        const imageData = JPEG_HEADER;
        const encrypted = await encryptBytes(imageData);

        await withCdnProxy(
          // deno-lint-ignore no-explicit-any
          () => new Response(encrypted as any, { status: 200 }),
          async () => {
            const response = await proxyRequest();
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("image/jpeg");
            expect(response.headers.get("cache-control")).toContain(
              "immutable",
            );
            const body = new Uint8Array(await response.arrayBuffer());
            expect(body).toEqual(imageData);
          },
        );
      });

      test("serves the red pixel and reports when the file is missing from storage", async () => {
        await withCdnProxy(
          () => new Response("Not Found", { status: 404 }),
          async () => {
            await expectBrokenImageResponse(await proxyRequest());
            expect(errors.lastMessage()).toContain("E_IMAGE_BROKEN");
            expect(errors.lastMessage()).toContain(
              "abc123-def4-5678-9abc-def012345678.jpg is missing from storage",
            );
          },
        );
      });

      test("serves the red pixel and reports when the stored file will not decrypt", async () => {
        await withCdnProxy(
          () => new Response("not encrypted bytes", { status: 200 }),
          async () => {
            await expectBrokenImageResponse(await proxyRequest());
            expect(errors.lastMessage()).toContain("E_IMAGE_BROKEN");
            expect(errors.lastMessage()).toContain(
              "abc123-def4-5678-9abc-def012345678.jpg could not be decrypted",
            );
          },
        );
      });

      test("serves the red pixel for the broken-image marker path", async () => {
        const response = await handleRequest(
          mockRequest(`/image/${BROKEN_IMAGE_FILENAME}`),
        );
        await expectBrokenImageResponse(response);
        // The marker is a fallback, not a broken record in itself.
        expect(errors.calls.length).toBe(0);
      });

      test("propagates non-404 storage errors as 503", async () => {
        await withCdnProxy(
          () => new Response("Unauthorized", { status: 401 }),
          async () => {
            await withExpectedError(async () => {
              await expectHtmlResponse(
                await proxyRequest(),
                503,
                "Temporary Error",
              );
            });
          },
        );
      });

      test("returns 404 for unknown extension", async () => {
        expect((await proxyRequest("bmp")).status).toBe(404);
      });

      describeWithEnv(
        "when storage is not enabled",
        { env: { STORAGE_ZONE_KEY: undefined, STORAGE_ZONE_NAME: undefined } },
        () => {
          test("returns 404", async () => {
            await withStorageDisabled(async () => {
              expect((await proxyRequest()).status).toBe(404);
            });
          });

          test("still serves the red pixel for the broken-image marker", async () => {
            await withStorageDisabled(async () => {
              await expectBrokenImageResponse(
                await handleRequest(
                  mockRequest(`/image/${BROKEN_IMAGE_FILENAME}`),
                ),
              );
            });
          });
        },
      );

      test("returns 404 for non-GET method", async () => {
        const request = new Request(`http://localhost${PROXY_PATH}.jpg`, {
          body: "test",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          method: "POST",
        });
        expect((await handleRequest(request)).status).toBe(404);
      });

      test("returns 404 for filename without extension", async () => {
        const response = await handleRequest(
          mockRequest("/image/abcdef123456"),
        );
        expect(response.status).toBe(404);
      });
    });
  },
);
