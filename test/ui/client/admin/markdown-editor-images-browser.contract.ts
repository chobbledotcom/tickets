/**
 * Browser contract for the image picker dialog at its real surface: the
 * served page-editor form, the app's own image-options route, and a real
 * Chromium. The direct tests in `markdown-editor-images.test.ts` mount an
 * isolated editor against a stubbed fetch; this file proves what only a real
 * page shows — the dialog on the admin form, a thumbnail inserted through
 * the real form submit, and the preview's rendered image.
 *
 * Runs under `deno task test:screenshot-contract`. The harness builds the
 * static assets before the served page loads them.
 * Like every `*-browser.contract.ts` file it never runs in the main suite
 * (it needs Chromium and the built bundles).
 */

import { Buffer } from "node:buffer";
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Locator, Page } from "playwright";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  describeWithBrowser,
  withSignedInPage,
} from "#test-utils/browser-contract.ts";
import {
  CONTENT_BOX,
  DIALOG,
  EDITOR_BUTTON,
  EMPTY_MESSAGE,
  expectDialogClosesWhen,
  expectFocusBackInEditor,
  gridAndLastOptionBoxes,
  NOTE,
  OPTION,
  THUMBNAIL,
  typeIntoEditorBody,
  waitForDialogClosed,
} from "#test-utils/markdown-image-contract.ts";
import { makeTestPng } from "#test-utils/test-image.ts";

// The page editor renders catalog copy, so the contract needs the full
// message catalog whether or not the shared preload ran first.
await ensureMessageGroups(MESSAGE_GROUPS);

describeWithBrowser(
  "the image picker dialog at the served page editor",
  // The local backend, not the test CDN: the upload path PUTs real bytes,
  // and the test zone's fake credentials would fail every upload.
  { db: true, storage: "local" },
  (contract) => {
    /** The shared signed-in page, bound to the contract's browser and
     * address. */
    const withPage = async <T>(run: (page: Page) => Promise<T>): Promise<T> =>
      withSignedInPage(contract.browser, contract.baseUrl, run);

    /** The new-page form with its rich editor mounted. */
    const openPageEditor = async (page: Page): Promise<void> => {
      await page.goto("/admin/site/pages/new");
      await page.locator(EDITOR_BUTTON).waitFor();
    };

    /** The content box's current markdown — what a save would store. */
    const contentValue = (page: Page): Promise<string> =>
      page.locator(CONTENT_BOX).inputValue();

    /** Opens the dialog and hands it over. */
    const openDialog = async (page: Page): Promise<Locator> => {
      await page.locator(EDITOR_BUTTON).click();
      const dialog = page.locator(DIALOG);
      await dialog.waitFor();
      return dialog;
    };

    /** Chooses one image by the exact name its thumbnail shows. */
    const chooseImage = async (page: Page, name: string): Promise<void> => {
      await page.locator(EDITOR_BUTTON).click();
      await page.locator(OPTION).getByText(name, { exact: true }).click();
    };

    /** Opens the page editor and types `text` into it: the first step of
     * every flow that starts from a fresh new-page form. */
    const openEditorAndType = async (
      page: Page,
      text: string,
    ): Promise<void> => {
      await openPageEditor(page);
      await typeIntoEditorBody(page, text);
    };

    test("shows the library's thumbnails, in name order", async () => {
      // Lighthouse is made first, so id order differs from name order and the
      // assert proves the names, not the row order.
      await makeImage("Lighthouse");
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        const dialog = await openDialog(page);

        await page.locator(OPTION).first().waitFor();
        expect(await dialog.locator(OPTION).allTextContents()).toEqual([
          "Harbour",
          "Lighthouse",
        ]);
        const sources = await dialog
          .locator(THUMBNAIL)
          .evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")));
        expect(sources).toEqual([
          "/image/harbour-thumb.webp",
          "/image/lighthouse-thumb.webp",
        ]);
      });
    });

    test("reaches a long library's lower rows by scrolling the grid", async () => {
      /* jscpd:ignore-start -- a list of strings, not code */
      const names = [
        "Alder",
        "Birch",
        "Cedar",
        "Dune",
        "Elm",
        "Fern",
        "Gorse",
        "Hazel",
        "Ivy",
        "Juniper",
        "Kelp",
        "Larch",
        "Moss",
        "Nettle",
        "Oak",
        "Pine",
        "Quince",
        "Rowan",
        "Spruce",
        "Teak",
        "Ulmus",
        "Viburnum",
        "Willow",
        "Yew",
      ];
      /* jscpd:ignore-end */
      for (const name of names) await makeImage(name);
      await withPage(async (page) => {
        await openPageEditor(page);
        await openDialog(page);
        const grid = page.locator(".md-image-grid");
        await page.locator(OPTION).first().waitFor();

        // The grid is a scroller of its own: the library is taller than the
        // grid, and the lower names wait below its visible box.
        expect(
          await grid.evaluate((el) => el.scrollHeight > el.clientHeight),
        ).toBe(true);
        expect(
          await grid.evaluate((el) => getComputedStyle(el).overflowY),
        ).toBe("auto");

        const { gridBox, optionBox: below } = await gridAndLastOptionBoxes(
          page,
          grid,
        );
        expect(below.y).toBeGreaterThanOrEqual(gridBox.y + gridBox.height);

        // Scrolling inside the grid brings the lower names into it, so the
        // owner reaches every image without the page's own scroll.
        await grid.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        const { gridBox: scrolled, optionBox: reached } =
          await gridAndLastOptionBoxes(page, grid);
        expect(reached.y).toBeLessThan(scrolled.y + scrolled.height);
      });
    });

    test("inserts the chosen image at the caret and keeps the surrounding words", async () => {
      const harbour = await makeImage("Harbour");
      await withPage(async (page) => {
        await openEditorAndType(page, "Where to find us");
        await page.keyboard.press("Enter");
        await chooseImage(page, "Harbour");

        expect(await contentValue(page)).toBe(
          `Where to find us\n\n![Harbour](img#${harbour.id})`,
        );
        // The rich view shows the picture itself: the short-form reference
        // resolves through the library to the image's real URL.
        const image = page.locator(
          '.ProseMirror img[src="/image/harbour.webp"]',
        );
        await image.waitFor();
        expect(await image.getAttribute("alt")).toBe("Harbour");
        // The insert closes the dialog and hands focus back to the editor.
        expect(await page.locator(DIALOG).isVisible()).toBe(false);
        await expectFocusBackInEditor(page);
      });
    });

    test("uploads a new image and inserts it at the caret", async () => {
      await withPage(async (page) => {
        await openEditorAndType(page, "Fresh from the camera.");
        await page.keyboard.press("Enter");

        const dialog = await openDialog(page);
        await dialog.locator('input[name="name"]').fill("Harbour Haze");
        // The server validates the upload as a real image, so the file must
        // be a decodable PNG, not arbitrary bytes. It is deliberately wide:
        // the picture must fit the editor box, not spill out of it.
        await dialog.locator('input[name="image"]').setInputFiles({
          buffer: Buffer.from(await makeTestPng(1600, 200)),
          mimeType: "image/png",
          name: "harbour-haze.png",
        });
        await dialog.getByRole("button", { name: "Upload" }).click();
        // The insert and the close land once the stubbed-less upload answers;
        // wait for the dialog to shut before reading the editor.
        await waitForDialogClosed(page);

        // The upload inserted the new image at the caret and closed the
        // dialog; the library keeps the upload the way the images area does.
        const saved = await contentValue(page);
        assertStringIncludes(saved, "![Harbour Haze](img#");
        assertStringIncludes(saved, "Fresh from the camera.");
        expect(await page.locator(DIALOG).isVisible()).toBe(false);

        // The wide picture renders inside the editor's content box.
        const picture = page.locator(".ProseMirror img").first();
        await picture.waitFor();
        const pictureBox = await picture.boundingBox();
        const editorBox = await page.locator(".ProseMirror").boundingBox();
        if (pictureBox === null || editorBox === null) {
          throw new Error("the picture or the editor is not on the page");
        }
        expect(pictureBox.width).toBeGreaterThan(100);
        expect(pictureBox.width).toBeLessThanOrEqual(editorBox.width);

        // Re-opening offers a clean form: the upload button works again and
        // the fields start empty.
        const reopened = await openDialog(page);
        const uploadButton = reopened.getByRole("button", { name: "Upload" });
        expect(await uploadButton.isEnabled()).toBe(true);
        expect(await reopened.locator('input[name="name"]').inputValue()).toBe(
          "",
        );
      });
    });

    test("stores the short reference through a real save and shows it on reopen", async () => {
      const harbour = await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        // The dialog's own upload form nests inside the page form, so the
        // page's Name field is the one the roles distinguish.
        await page
          .getByRole("textbox", { name: t("site.pages.field.name") })
          .fill("How to find us");
        await page.locator('input[name="slug"]').fill("how-to-find-us");
        await typeIntoEditorBody(page, "Take the coast road.");
        await page.keyboard.press("Enter");
        await chooseImage(page, "Harbour");
        await page
          .getByRole("button", { name: t("site.pages.create_submit") })
          .click();

        // The save lands on the page's own edit form, so the box there shows
        // what the save stored.
        const reference = `![Harbour](img#${harbour.id})`;
        assertStringIncludes(await contentValue(page), reference);

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
        assertStringIncludes(await contentValue(page), reference);
        assertStringIncludes(await contentValue(page), "Take the coast road.");
      });
    });

    test("the preview renders the chosen image's address and its alt text", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openEditorAndType(page, "The harbour from the sea.");
        await chooseImage(page, "Harbour");
        // The editor's mode toggle shares the preview link's class, so the
        // button is picked by its own name.
        await page.getByRole("button", { name: "Preview" }).click();

        const shown = page.locator("dialog.admin-modal .md-preview-content");
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
        await openEditorAndType(page, "Written in the visual editor.");

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

    /** The page's own words typed first, then the dialog opened and the note
     * it settles on read back — the shape the empty and unreachable
     * libraries share. The expected message pins the wait: the loading
     * state shows the same note element with different words. */
    const openDialogOverUnchangedWords = async (
      page: Page,
      message: string,
    ): Promise<{ content: string; note: string; dialog: Locator }> => {
      await openEditorAndType(page, "Unchanged words.");
      const dialog = await openDialog(page);
      await dialog.locator(NOTE).filter({ hasText: message }).waitFor();
      return {
        content: await contentValue(page),
        dialog,
        note: (await dialog.textContent()) ?? "",
      };
    };

    /** Asserts the dialog's note carries `message`, the grid offers no
     * option, and the page content is untouched. */
    const expectNoteWithoutOptions = async (
      answered: { content: string; dialog: Locator; note: string },
      message: string,
    ): Promise<void> => {
      assertStringIncludes(answered.note, message);
      expect(await answered.dialog.locator(OPTION).count()).toBe(0);
      expect(answered.content).toBe("Unchanged words.");
    };

    test("says the library is empty and offers nothing to choose", async () => {
      await withPage(async (page) => {
        const answered = await openDialogOverUnchangedWords(
          page,
          EMPTY_MESSAGE,
        );

        await expectNoteWithoutOptions(answered, EMPTY_MESSAGE);
      });
    });

    test("modal backdrop swallows toolbar clicks while the dialog is open", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await openDialog(page);
        await page.locator(OPTION).first().waitFor();

        // The modal dialog's backdrop intercepts every pointer event, so a
        // click aimed at the toolbar button lands on the backdrop and the
        // dialog stays open. Force it: the click happens, the dialog ignores
        // it.
        await page.locator(EDITOR_BUTTON).click({ force: true });
        await page.waitForTimeout(100);
        expect(await page.locator(DIALOG).getAttribute("open")).not.toBeNull();
      });
    });

    test("closes on Escape and puts focus back in the editor", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await openPageEditor(page);
        await openDialog(page);

        await expectDialogClosesWhen(page, (p) => p.keyboard.press("Escape"));
        // The native dialog hands focus back to the element that held it.
        await expectFocusBackInEditor(page);
      });
    });

    test("stays closed when the library answers after the owner dismissed it", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        // The gate holds the answer until the click has dismissed the
        // dialog, so the test observes the answer arriving after dismissal.
        const responseGate = Promise.withResolvers<void>();
        await page.route("**/admin/images/options", async (route) => {
          await responseGate.promise;
          await route.fulfill({
            body: JSON.stringify({
              images: [
                {
                  full: "/image/harbour.webp",
                  id: 2,
                  name: "Harbour",
                  thumb: "/image/harbour-thumb.webp",
                },
              ],
            }),
            contentType: "application/json",
          });
        });
        await openPageEditor(page);

        const dialog = await openDialog(page);
        // The modal backdrop swallows toolbar clicks, so Escape dismisses.
        await page.keyboard.press("Escape");
        await waitForDialogClosed(page);
        responseGate.resolve();
        await page.waitForTimeout(500);

        // The late answer must not reopen the dismissed dialog.
        expect(await dialog.getAttribute("open")).toBeNull();
        expect(await dialog.locator(OPTION).count()).toBe(0);
      });
    });
    test("the new listing form's Images field opens the shared picker", async () => {
      await makeImage("Harbour");
      await withPage(async (page) => {
        await page.goto("/admin/listing/new?template=physical-product");
        const section = page.locator("[data-listing-images]");
        await section.locator("[data-listing-images-trigger]").click();

        const dialog = section.locator(DIALOG);
        await dialog.waitFor();
        const options = dialog.locator(OPTION);
        await options.getByText("Harbour", { exact: true }).waitFor();
        expect(await dialog.getAttribute("open")).not.toBeNull();
        expect(await options.allTextContents()).toEqual(["Harbour"]);
      });
    });
  },
);
