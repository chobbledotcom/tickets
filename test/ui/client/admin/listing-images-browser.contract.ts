/**
 * Browser contract for the listing editor's Images tab: the same picker the
 * new physical-product form uses, at its real served surface. Direct tests
 * cover the client widget against stubbed fetches; this file proves the saved
 * selection, the picker, and the form save agree on one listing.
 *
 * Runs under `deno task test:screenshot-contract`, which builds the static
 * assets and provides Chromium.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Page } from "playwright";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import { requireValue } from "#shared/required-value.ts";
import { listingWithImages, makeImage } from "#test-utils/admin-images.ts";
import { describeWithBrowser } from "#test-utils/browser-contract.ts";

await ensureMessageGroups(MESSAGE_GROUPS);

const DIALOG = ".md-image-dialog";
const OPTION = ".md-image-option";
const REMOVE = ".listing-images-remove";
const TRIGGER = "[data-listing-images-trigger]";

describeWithBrowser(
  "the listing editor's Images tab",
  { db: true, storage: "local" },
  (contract) => {
    const { withPage } = contract;

    const openTab = async (page: Page, listingId: number): Promise<void> => {
      await page.goto(`/admin/listing/${listingId}/images`);
      await page.locator(TRIGGER).waitFor();
    };

    const savedNames = (page: Page): Promise<string[]> =>
      page
        .locator(REMOVE)
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label") ?? ""),
        );

    const savedIds = (page: Page): Promise<string[]> =>
      page
        .locator('input[name="imageIds"]')
        .evaluateAll((inputs) =>
          inputs.map((input) => input.getAttribute("value") ?? ""),
        );

    /** Opens the picker and waits for the library it fetches. */
    const openPicker = async (page: Page) => {
      await page.locator(TRIGGER).click();
      const dialog = page.locator(DIALOG);
      await dialog.waitFor();
      await dialog.locator(OPTION).first().waitFor();
      return dialog;
    };

    test("opens the picker over the saved picture and appends a choice", async () => {
      const { listing, images } = await listingWithImages("Gallery edit", [
        "Harbour",
      ]);
      const [harbourPicture] = images;
      const harbour = requireValue(harbourPicture, "the harbour picture");
      const lighthouse = await makeImage("Lighthouse");

      await withPage(async (page) => {
        await openTab(page, listing.id);
        expect(await savedNames(page)).toEqual(["Remove Harbour"]);
        expect(await savedIds(page)).toEqual([String(harbour.id)]);

        // The choose control and the save sit on one line, with save at the
        // row's right edge.
        const chooseBox = await page.locator(TRIGGER).boundingBox();
        const saveBox = await page
          .getByRole("button", { name: "Save Changes" })
          .boundingBox();
        if (chooseBox === null || saveBox === null) {
          throw new Error("the Images tab actions are not on the page");
        }
        const chooseCentre = chooseBox.y + chooseBox.height / 2;
        const saveCentre = saveBox.y + saveBox.height / 2;
        expect(Math.abs(chooseCentre - saveCentre)).toBeLessThanOrEqual(1);
        expect(saveBox.x).toBeGreaterThan(chooseBox.x + chooseBox.width);

        const dialog = await openPicker(page);
        expect(await dialog.locator(OPTION).allTextContents()).toEqual([
          "Harbour",
          "Lighthouse",
        ]);
        expect(
          await dialog
            .locator(`${OPTION}[aria-pressed="true"]`)
            .allTextContents(),
        ).toEqual(["Harbour"]);

        await dialog
          .locator(OPTION)
          .getByText("Lighthouse", { exact: true })
          .click();
        await dialog.locator(".md-image-confirm").click();
        expect(await savedIds(page)).toEqual([
          String(harbour.id),
          String(lighthouse.id),
        ]);

        await page.getByRole("button", { name: "Save Changes" }).click();
        await page
          .locator(`${REMOVE}[aria-label="Remove Lighthouse"]`)
          .waitFor();
        expect(await savedNames(page)).toEqual([
          "Remove Harbour",
          "Remove Lighthouse",
        ]);
        expect(await savedIds(page)).toEqual([
          String(harbour.id),
          String(lighthouse.id),
        ]);
        expect(await page.locator(".success").textContent()).toContain(
          "Images updated",
        );
      });
    });

    test("removes a saved picture and persists the remaining one", async () => {
      const { listing, images } = await listingWithImages("Gallery remove", [
        "Harbour",
        "Lighthouse",
      ]);
      const [, lighthousePicture] = images;
      const lighthouse = requireValue(
        lighthousePicture,
        "the lighthouse picture",
      );

      await withPage(async (page) => {
        await openTab(page, listing.id);
        await page.locator(`${REMOVE}[aria-label="Remove Harbour"]`).click();
        expect(await savedNames(page)).toEqual(["Remove Lighthouse"]);

        await page.getByRole("button", { name: "Save Changes" }).click();
        await page.locator(".success").waitFor();
        expect(await savedIds(page)).toEqual([String(lighthouse.id)]);
      });
    });
  },
);
