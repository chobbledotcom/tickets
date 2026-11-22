/**
 * Browser contract for drag to reorder, in a real browser on the served
 * pages. A page with scripts shows the drag handles and hides the arrows,
 * which are for a page without scripts. A handle is a bare glyph, and the
 * column has no heading. The listings page stores a drop at
 * once. A listing's Images tab moves the pictures in its form, and Save
 * stores them, so pictures that are not saved yet can move too.
 *
 * Runs under `deno task test:screenshot-contract`, which builds the static
 * assets and provides Chromium.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Locator, Page } from "playwright";
import { listingWithImages, makeImage } from "#test-utils/admin-images.ts";
import { describeWithBrowser } from "#test-utils/browser-contract.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { DIALOG, OPTION } from "#test-utils/markdown-image-contract.ts";

const HANDLE = "[data-sortable-handle]";

/** Press the handle, move to the left or top edge of the target, and let go,
 *  as a person drags with a mouse. */
const dragOnto = async (
  page: Page,
  handle: Locator,
  target: Locator,
  edge: "left" | "top",
): Promise<void> => {
  await handle.hover();
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error("Nothing to drag");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const x = edge === "left" ? to.x + 4 : to.x + to.width / 2;
  const y = edge === "top" ? to.y + 4 : to.y + to.height / 2;
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
};

/** The errors a page throws, gathered while `run` works with it. */
const pageErrorsDuring = async (
  page: Page,
  run: () => Promise<void>,
): Promise<string[]> => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await run();
  return errors;
};

describeWithBrowser(
  "drag to reorder",
  { db: true, storage: "local" },
  (contract) => {
    const { withPage } = contract;

    test("the listings page hides the arrows and stores a dragged row", async () => {
      const alpha = await createTestListing({ name: "Alpha" });
      await createTestListing({ name: "Bravo" });
      const charlie = await createTestListing({ name: "Charlie" });

      await withPage(async (page) => {
        await page.goto("/admin/listings");
        const row = (id: number) =>
          page.locator(
            `tbody[data-sortable] > tr:has([data-sortable-path="/admin/listing/${id}"])`,
          );
        await row(alpha.id).waitFor();
        const handle = row(alpha.id).locator(HANDLE);
        await handle.hover();
        expect({
          arrowShown: await page
            .locator('tbody[data-sortable] form[action$="/move-after"]')
            .first()
            .isVisible(),
          handle: await handle.evaluate((button) => {
            const style = getComputedStyle(button);
            return [style.borderStyle, style.backgroundColor];
          }),
          header: await page.locator("th.col-reorder").textContent(),
        }).toEqual({
          arrowShown: false,
          handle: ["none", "rgba(0, 0, 0, 0)"],
          header: "",
        });

        const errors = await pageErrorsDuring(page, async () => {
          await Promise.all([
            page.waitForURL(/flash=/),
            dragOnto(
              page,
              row(charlie.id).locator(HANDLE),
              row(alpha.id),
              "top",
            ),
          ]);
        });

        expect(errors).toEqual([]);
        expect(
          await page
            .locator("tbody[data-sortable] > tr [data-sortable-anchor]")
            .evaluateAll((handles) =>
              handles.map((handle) =>
                handle.getAttribute("data-sortable-anchor"),
              ),
            ),
        ).toEqual([String(charlie.id), String(alpha.id), expect.any(String)]);
      });
    });

    test("the Images tab moves a dragged picture in the form, and Save stores it", async () => {
      const { listing, images } = await listingWithImages("Gallery order", [
        "Harbour",
        "Lighthouse",
        "Pier",
      ]);
      const [harbour, lighthouse, pier] = images.map((image) =>
        String(image.id),
      );

      await withPage(async (page) => {
        await page.goto(`/admin/listing/${listing.id}/images`);
        const card = (id: string) =>
          page.locator(`.listing-images-item[data-image-id="${id}"]`);
        await card(harbour!).waitFor();
        expect(
          await page
            .locator(".listing-images-item button[formaction]")
            .first()
            .isVisible(),
        ).toBe(false);

        const errors = await pageErrorsDuring(page, () =>
          dragOnto(page, card(pier!).locator(HANDLE), card(harbour!), "left"),
        );
        expect(errors).toEqual([]);
        const ids = () =>
          page
            .locator('input[name="imageIds"]')
            .evaluateAll((inputs) =>
              inputs.map((input) => input.getAttribute("value")),
            );
        expect(await ids()).toEqual([pier, harbour, lighthouse]);

        await page.getByRole("button", { name: "Save Changes" }).click();
        await page.locator(".success").waitFor();
        expect(await ids()).toEqual([pier, harbour, lighthouse]);
      });
    });

    test("a picture added in the picker can be dragged before it is saved", async () => {
      const { listing, images } = await listingWithImages("Gallery new", [
        "Harbour",
      ]);
      const harbour = String(images[0]!.id);
      const lighthouse = String((await makeImage("Lighthouse")).id);

      await withPage(async (page) => {
        await page.goto(`/admin/listing/${listing.id}/images`);
        await page.locator("[data-listing-images-trigger]").click();
        const dialog = page.locator(DIALOG);
        await dialog
          .locator(OPTION)
          .getByText("Lighthouse", { exact: true })
          .click();
        await dialog.locator(".md-image-confirm").click();
        const card = (id: string) =>
          page.locator(`.listing-images-item[data-image-id="${id}"]`);

        const errors = await pageErrorsDuring(page, () =>
          dragOnto(
            page,
            card(lighthouse).locator(HANDLE),
            card(harbour),
            "left",
          ),
        );

        expect(errors).toEqual([]);
        expect(
          await page
            .locator('input[name="imageIds"]')
            .evaluateAll((inputs) =>
              inputs.map((input) => input.getAttribute("value")),
            ),
        ).toEqual([lighthouse, harbour]);
      });
    });
  },
);
