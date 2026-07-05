import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  describeWithEnv,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockRequest,
  setupListingAndLogin,
  testCookie,
} from "#test-utils";

describeWithEnv(
  "server images > error messages",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("image error messages in rendered pages", () => {
      test("displays image error on admin dashboard", async () => {
        const cookie = await testCookie();
        const response = await handleRequest(
          mockRequest(`/admin?flash=${FLASH_TEST_ID}`, {
            headers: {
              cookie: `${cookie}; ${flashCookieHeader(
                "Image exceeds the 256KB size limit",
                false,
              )}`,
            },
          }),
        );
        await expectHtmlResponse(
          response,
          200,
          "Image exceeds the 256KB size limit",
        );
      });

      test("displays image error on listing detail page", async () => {
        const { listing, cookie } = await setupListingAndLogin();

        const response = await handleRequest(
          mockRequest(`/admin/listing/${listing.id}?flash=${FLASH_TEST_ID}`, {
            headers: {
              cookie: `${cookie}; ${flashCookieHeader(
                "Image must be a JPEG, PNG, GIF, or WebP file",
                false,
              )}`,
            },
          }),
        );
        await expectHtmlResponse(
          response,
          200,
          "Image must be a JPEG, PNG, GIF, or WebP file",
        );
      });

      test("does not display image error when flash cookie is absent", async () => {
        const { listing, cookie } = await setupListingAndLogin();

        const response = await handleRequest(
          mockRequest(`/admin/listing/${listing.id}`, { headers: { cookie } }),
        );
        const html = await response.text();
        expect(html).not.toContain("image was not uploaded");
      });
    });
  },
);
