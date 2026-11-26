/**
 * The camera link at its real surface: the served admin bundle opens the
 * CDN-hosted MP4 in the admin modal. The video is not fetched here; the test
 * proves the link, the modal, and how the player is wired.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithBrowser } from "#test-utils/browser-contract.ts";

const HREF =
  "https://assets.example.com/static/guides/create-a-listing-abc.mp4";

describeWithBrowser(
  "the guide video link at the served admin page",
  { db: true },
  (contract) => {
    test("plays the CDN video in the admin modal", async () => {
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
        const video = dialog.locator("video.guide-video-player");
        await video.waitFor({ state: "attached" });

        expect(await dialog.getAttribute("data-modal-key")).toBe(
          `guide-video:${HREF}`,
        );
        expect(await dialog.locator(".admin-modal-title").textContent()).toBe(
          "Create a listing",
        );
        expect(await video.getAttribute("title")).toBe("Create a listing");
        expect(await video.getAttribute("referrerpolicy")).toBe("no-referrer");

        // `muted` does not reflect to an attribute, so read the properties the
        // browser uses to decide whether autoplay is allowed.
        expect(
          await video.evaluate((element) => {
            const player = element as HTMLVideoElement;
            return {
              autoplay: player.autoplay,
              controls: player.controls,
              muted: player.muted,
              playsInline: player.playsInline,
              preload: player.preload,
              src: player.src,
            };
          }),
        ).toEqual({
          autoplay: true,
          controls: true,
          muted: true,
          playsInline: true,
          preload: "metadata",
          src: HREF,
        });
      });
    });
  },
);
