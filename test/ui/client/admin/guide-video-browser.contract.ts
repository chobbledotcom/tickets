/**
 * The camera link at its real surface: the served admin bundle opens the CDN
 * player in the admin modal. The iframe is not fetched here; the test proves
 * the link, the modal, and the iframe address.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithBrowser } from "#test-utils/browser-contract.ts";

const HREF =
  "https://assets.example.com/static/guides/abc/create-a-listing/index.html";

describeWithBrowser(
  "the guide video link at the served admin page",
  { db: true },
  (contract) => {
    test("opens the CDN player in the admin modal", async () => {
      await contract.withPage(async (page) => {
        await page.goto("/admin/");
        await page.evaluate((href) => {
          const link = document.createElement("a");
          link.href = href;
          link.title = "Watch guide video";
          link.textContent = "Watch guide video";
          link.dataset.guideTitle = "Create a listing";
          link.dataset.guideVideo = "";
          document.body.append(link);
        }, HREF);

        await page.locator("a[data-guide-video]").click();
        const dialog = page.locator("dialog.admin-modal");
        await dialog.waitFor({ state: "visible" });
        const iframe = dialog.locator("iframe.guide-video-frame");
        await iframe.waitFor({ state: "attached" });

        expect(await dialog.getAttribute("data-modal-key")).toBe(
          `guide-video:${HREF}`,
        );
        expect(await dialog.locator(".admin-modal-title").textContent()).toBe(
          "Create a listing",
        );
        expect(await iframe.getAttribute("src")).toBe(HREF);
        expect(await iframe.getAttribute("title")).toBe("Create a listing");
        expect(await iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
      });
    });
  },
);
