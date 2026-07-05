import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { encryptBytes } from "#shared/crypto/encryption.ts";
import {
  describeWithEnv,
  expectHtmlResponse,
  JPEG_HEADER,
  mockRequest,
  withCdnProxy,
  withExpectedError,
  withStorageDisabled,
} from "#test-utils";

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

      test("returns 404 when file does not exist in storage", async () => {
        await withCdnProxy(
          () => new Response("Not Found", { status: 404 }),
          async () => {
            expect((await proxyRequest()).status).toBe(404);
          },
        );
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
