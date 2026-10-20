/**
 * Browser contract for the image dropdown at its real surface: the served
 * page-editor form, the app's own image-options route, and a real Chromium.
 * The direct tests in `markdown-editor-images.test.ts` mount an isolated
 * editor against a stubbed fetch; this file proves what only a real page
 * shows — the dropdown on the admin form, the choice stored through the real
 * form submit, and the preview's rendered image.
 *
 * Runs through the harness with the static assets built:
 * `deno task test:files test/ui/client/admin/markdown-editor-images-browser.contract.ts`.
 * Like every `*-browser.contract.ts` file it never runs in the main suite
 * (it needs Chromium and the built bundles).
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, it as test } from "@std/testing/bdd";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import { browserLaunchOptions } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { defineLoopbackServer } from "#scripts/specs/evidence/server.ts";
import { denoServeHandler } from "#src/serve-app.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testCookie } from "#test-utils/session.ts";

// The page editor renders catalog copy, so the contract needs the full
// message catalog whether or not the shared preload ran first.
await ensureMessageGroups(MESSAGE_GROUPS);

const EDITOR_BUTTON = ".md-toolbar-image";
const PANEL = ".md-image-dropdown";
const OPTION = ".md-image-option";
const NOTE = ".md-image-dropdown-note";
const CONTENT_BOX = 'textarea[name="content"]';
const EMPTY_MESSAGE = "No images uploaded yet.";
const UNAVAILABLE_MESSAGE = "Images are unavailable right now.";

describeWithEnv(
  "the image dropdown at the served page editor",
  { db: true, storage: "cdn" },
  () => {
    let closeSuite: () => Promise<void>;
    let baseUrl: string;
    let browser: Browser;

    beforeAll(async () => {
      const server = defineLoopbackServer(denoServeHandler)();
      baseUrl = server.baseUrl;
      browser = await chromium.launch(
        browserLaunchOptions(true, await chromiumExecutable()),
      );
      closeSuite = async () => {
        await browser.close();
        await server.close();
      };
    });

    afterAll(() => closeSuite());

    /** A fresh signed-in context on the app's own address, closed with the test.
     * Reduced motion skips the app's cross-document view transition, whose
     * cross-fade keeps a freshly loaded page's elements unstable for clicks. */
    const withPage = async <T>(run: (page: Page) => Promise<T>): Promise<T> => {
      const context = await browser.newContext({
        baseURL: baseUrl,
        reducedMotion: "reduce",
      });
      const [pair] = (await testCookie()).split(";", 1);
      const splitAt = pair?.indexOf("=") ?? -1;
      if (pair === undefined || splitAt < 1 || splitAt === pair.length - 1) {
        throw new Error("The test owner cookie is malformed");
      }
      await context.addCookies([
        {
          name: pair.slice(0, splitAt),
          url: baseUrl,
          value: pair.slice(splitAt + 1),
        },
      ]);
      const page = await context.newPage();
      try {
        return await run(page);
      } finally {
        await context.close();
      }
    };

    /** The new-page form with its rich editor mounted. */
    const openPageEditor = async (page: Page): Promise<void> => {
      await page.goto("/admin/site/pages/new");
      await page.locator(EDITOR_BUTTON).waitFor();
    };

    /** The content box's current markdown — what a save would store. */
    const contentValue = (page: Page): Promise<string> =>
      page.locator(CONTENT_BOX).inputValue();

    /** Opens the dropdown and hands the panel over. */
    const openDropdown = async (page: Page): Promise<Locator> => {
      await page.locator(EDITOR_BUTTON).click();
      const panel = page.locator(PANEL);
      await panel.waitFor();
      return panel;
    };

    /** Chooses one image by the exact name the panel shows. */
    const chooseImage = async (page: Page, name: string): Promise<void> => {
      await page.locator(EDITOR_BUTTON).click();
      await page.locator(OPTION).getByText(name, { exact: true }).click();
    };

    test("offers the library's images by name, in name order", async () => {
      // Lighthouse is made first, so id order differs from name order and the
      // assert proves the names, not the row order.
      await makeImage("Lighthouse");
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        const panel = await openDropdown(page);

        await page.locator(OPTION).first().waitFor();
        expect(await panel.locator(OPTION).allTextContents()).toEqual([
          "Harbour",
          "Lighthouse",
        ]);
        expect(await panel.locator("img").count()).toBe(0);
      });
    });

    test("inserts the chosen image at the caret and keeps the surrounding words", async () => {
      const harbour = await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        const body = page.locator(".ProseMirror");
        await body.click();
        await page.keyboard.type("Where to find us");
        await page.keyboard.press("Enter");
        await chooseImage(page, "Harbour");

        expect(await contentValue(page)).toBe(
          `Where to find us\n\n![Harbour](img#${harbour.id})`,
        );
      });
    });

    test("stores the short reference through a real save and shows it on reopen", async () => {
      const harbour = await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await page.locator('input[name="name"]').fill("How to find us");
        await page.locator('input[name="slug"]').fill("how-to-find-us");
        await page.locator(".ProseMirror").click();
        await page.keyboard.type("Take the coast road.");
        await page.keyboard.press("Enter");
        await chooseImage(page, "Harbour");
        await page
          .getByRole("button", { name: t("site.pages.create_submit") })
          .click();

        // The save lands on the page's own edit form, so the box there shows
        // what the save stored.
        const reference = `![Harbour](img#${harbour.id})`;
        expect(await contentValue(page)).toContain(reference);

        // Reopening goes through the owner's list, the way the owner reaches
        // it: the row's link names the page's own edit form, and the story
        // follows it. The click itself stalls in headless Chromium while the
        // app's cross-document view transition holds the new page's frames,
        // so the way in is read and followed rather than clicked.
        await page.goto("/admin/site/pages");
        const row = page.getByRole("link", { name: "How to find us" });
        const wayIn = await row.getAttribute("href");
        if (wayIn === null) throw new Error("the list offered no way in");
        await page.goto(wayIn);
        expect(await contentValue(page)).toContain(reference);
        expect(await contentValue(page)).toContain("Take the coast road.");
      });
    });

    test("the preview renders the chosen image's address and its alt text", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await page.locator(".ProseMirror").click();
        await page.keyboard.type("The harbour from the sea.");
        await chooseImage(page, "Harbour");
        // The editor's mode toggle shares the preview link's class, so the
        // button is picked by its own name.
        await page.getByRole("button", { name: "Preview" }).click();

        const shown = page.locator(".md-preview-dialog .md-preview-content");
        await shown.locator("img").waitFor();
        expect(await shown.locator("img").getAttribute("src")).toBe(
          "/image/harbour.webp",
        );
        expect(await shown.locator("img").getAttribute("alt")).toBe("Harbour");
      });
    });

    test("a plain-text edit and a visual/markdown switch keep the content", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await page.locator(".ProseMirror").click();
        await page.keyboard.type("Written in the visual editor.");

        // The switch to markdown reveals the textarea; the plain edit lands
        // there, and the switch back rebuilds the visual editor from it.
        await page.getByRole("button", { name: "Edit markdown" }).click();
        const box = page.locator(CONTENT_BOX);
        await box.click();
        await page.keyboard.press("End");
        await page.keyboard.type(" Edited as plain text.");
        expect(await contentValue(page)).toBe(
          "Written in the visual editor. Edited as plain text.",
        );

        await page.getByRole("button", { name: "Edit visually" }).click();
        expect(await contentValue(page)).toBe(
          "Written in the visual editor. Edited as plain text.",
        );
      });
    });

    /** The page's own words typed first, then the dropdown opened and the
     * note it settles on read back — the shape the empty and unreachable
     * libraries share. The expected message pins the wait: the loading
     * state shows the same note element with different words. */
    const openDropdownOverUnchangedWords = async (
      page: Page,
      message: string,
    ): Promise<{ content: string; note: string; panel: Locator }> => {
      await openPageEditor(page);
      await page.locator(".ProseMirror").click();
      await page.keyboard.type("Unchanged words.");
      const panel = await openDropdown(page);
      await panel.locator(NOTE).filter({ hasText: message }).waitFor();
      return {
        content: await contentValue(page),
        note: (await panel.textContent()) ?? "",
        panel,
      };
    };

    test("says the library is empty and offers nothing to choose", async () => {
      await withPage(async (page) => {
        const { content, note, panel } = await openDropdownOverUnchangedWords(
          page,
          EMPTY_MESSAGE,
        );

        expect(note).toContain(EMPTY_MESSAGE);
        expect(await panel.locator(OPTION).count()).toBe(0);
        expect(content).toBe("Unchanged words.");
      });
    });

    test("says the images are unavailable when the library cannot be reached", async () => {
      await withPage(async (page) => {
        await page.route("**/admin/images/options", (route) => route.abort());
        const { content, note, panel } = await openDropdownOverUnchangedWords(
          page,
          UNAVAILABLE_MESSAGE,
        );

        expect(note).toContain(UNAVAILABLE_MESSAGE);
        expect(await panel.locator(OPTION).count()).toBe(0);
        expect(content).toBe("Unchanged words.");
      });
    });

    test("retries the library after a failed load and inserts once it recovers", async () => {
      const harbour = await makeImage("Harbour");
      let failed = false;
      await withPage(async (page) => {
        await page.route("**/admin/images/options", (route) => {
          if (failed) return route.continue();
          failed = true;
          return route.abort();
        });
        await openPageEditor(page);

        const panel = await openDropdown(page);
        await panel
          .locator(NOTE)
          .filter({ hasText: UNAVAILABLE_MESSAGE })
          .waitFor();
        expect(await panel.textContent()).toContain(UNAVAILABLE_MESSAGE);

        // Shut and reopen: a failed load is never cached, so the second open
        // asks the route again and the real answer arrives.
        await page.locator(EDITOR_BUTTON).click();
        await page.locator(EDITOR_BUTTON).click();
        await page
          .locator(OPTION)
          .getByText("Harbour", { exact: true })
          .click();
        expect(await contentValue(page)).toBe(`![Harbour](img#${harbour.id})`);
      });
    });

    test("closes when the Image button is clicked again", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await openDropdown(page);
        expect(
          await page.locator(EDITOR_BUTTON).getAttribute("aria-expanded"),
        ).toBe("true");

        await page.locator(EDITOR_BUTTON).click();
        expect(await page.locator(PANEL).isVisible()).toBe(false);
        expect(
          await page.locator(EDITOR_BUTTON).getAttribute("aria-expanded"),
        ).toBe("false");
      });
    });

    test("closes when the click lands outside the control", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await openDropdown(page);

        await page.locator("h1").click();
        expect(await page.locator(PANEL).isVisible()).toBe(false);
      });
    });

    test("closes on Escape and puts focus back on the Image button", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await openDropdown(page);

        await page.keyboard.press("Escape");
        expect(await page.locator(PANEL).isVisible()).toBe(false);
        expect(
          await page.evaluate(
            () =>
              document.activeElement ===
              document.querySelector(".md-toolbar-image"),
          ),
        ).toBe(true);
      });
    });

    test("stays closed when the library answers after the owner dismissed it", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        // The gate holds the answer until the click has dismissed the
        // panel, so the test observes the answer arriving after dismissal.
        const responseGate = Promise.withResolvers<void>();
        await page.route("**/admin/images/options", async (route) => {
          await responseGate.promise;
          await route.fulfill({
            body: JSON.stringify({ images: [{ id: 2, name: "Harbour" }] }),
            contentType: "application/json",
          });
        });
        await openPageEditor(page);

        const panel = await openDropdown(page);
        await page.locator("h1").click();
        responseGate.resolve();
        await page.waitForTimeout(500);

        expect(await panel.isVisible()).toBe(false);
        expect(await panel.locator(OPTION).count()).toBe(0);
        expect(await panel.getAttribute("data-state")).toBe("loading");
      });
    });
  },
);
