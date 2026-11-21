/**
 * The Images field on a new listing (`src/ui/client/admin/listing-images.ts`):
 * the stored selection, the shared picker's multiple-choice flow, removal,
 * and the upload that keeps the window open.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import type { ChosenImage } from "#shared/images/picker.ts";
import { initListingImages } from "#src/ui/client/admin/listing-images.ts";
import { ListingImagesField } from "#templates/admin/listings/listing-images.tsx";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { requireElement } from "#test-utils/happy-dom.ts";
import {
  ADMIN_TEMPLATES,
  cleanup,
  installDom,
} from "#test-utils/markdown-editor-dom.ts";
import {
  closeControl,
  expectLoadFailureThenClose,
  fetchStubHolder,
  flush,
  json,
  optionByName,
  redirected,
  restoreHeldStub,
  submitUpload,
  twoImageList,
  untilReady,
} from "#test-utils/markdown-image-dialog.ts";

afterEach(cleanup);
afterEach(restoreHeldStub);

const sectionHtml = (
  stored: readonly ChosenImage[] = [],
  movePath?: string,
): string =>
  `<form action="/admin/listing" method="post">${String(
    ListingImagesField({ movePath, selected: stored }),
  )}</form>`;

/** One stored picture as a rejected create renders it. */
const storedImage = (id: number, name: string, thumb: string): ChosenImage => ({
  id,
  name,
  thumb,
});

/** The one element the selector names in this window. */
const part = <T extends Element>(window: Window, selector: string): T =>
  requireElement<T>(window.document, selector);

const mounted = async (
  replies: [FetchReply, ...FetchReply[]],
  stored: readonly ChosenImage[] = [],
): Promise<{
  dialog: HTMLDialogElement;
  grid: HTMLElement;
  window: Window;
}> => {
  fetchStubHolder.stub = stubFetch(...replies);
  const window = installDom(ADMIN_TEMPLATES + sectionHtml(stored));
  initListingImages();
  part<HTMLButtonElement>(window, "[data-listing-images-trigger]").click();
  const dialog = part<HTMLDialogElement>(window, "dialog.admin-modal");
  const grid = part<HTMLElement>(window, ".md-image-grid");
  await untilReady(grid);
  return { dialog, grid, window };
};

/** One attribute of each matching element, in document order. */
const attributesOf = (
  window: Window,
  selector: string,
  attribute: string,
): (string | null)[] =>
  [...window.document.querySelectorAll(selector)].map((element) =>
    element.getAttribute(attribute),
  );

/** The value of each hidden image id input, in order. */
const imageIdValues = (window: Window): (string | null)[] =>
  attributesOf(window, 'input[name="imageIds"]', "value");

/** The chosen pictures' remove labels, in order. */
const removeLabels = (window: Window): (string | null)[] =>
  attributesOf(window, ".listing-images-remove", "aria-label");

const chose = (window: Window, name: string): void => {
  optionByName(window, name).click();
};

/** The chosen ids and remove labels, in order. */
const expectSelection = (
  window: Window,
  ids: string[],
  labels: string[],
): void => {
  expect(imageIdValues(window)).toEqual(ids);
  expect(removeLabels(window)).toEqual(labels);
};

/** Confirms the window's marked pictures into the form. */
const confirmSelection = (window: Window): void => {
  requireElement<HTMLButtonElement>(
    window.document,
    ".md-image-confirm",
  ).click();
};

/** The upload replies whose refreshed library still holds only the two
 *  pictures it started with, so a just-uploaded picture is not listed. */
const uploadToStaleLibrary = (): [FetchReply, FetchReply, FetchReply] => [
  twoImageList(),
  redirected("/admin/images/12/edit"),
  twoImageList(),
];

/** Upload Harbour through the window, then confirm the marked pictures. */
const uploadHarbourAndConfirm = async (
  replies: [FetchReply, FetchReply, FetchReply],
): Promise<Window> => {
  const { dialog, window } = await mounted(replies);
  await submitUpload(dialog, "Harbour");
  await flush();
  confirmSelection(window);
  return window;
};

describe("the listing images field", () => {
  test("renders the pictures a refused create carried", () => {
    const window = installDom(
      ADMIN_TEMPLATES +
        sectionHtml([storedImage(4, "Seed", "/image/seed-thumb.webp")]),
    );
    initListingImages();

    const item = requireElement<HTMLLIElement>(
      window.document,
      ".listing-images-item",
    );
    expect(item.querySelector("span")).toBeNull();
    expect(item.querySelector("img")?.getAttribute("src")).toBe(
      "/image/seed-thumb.webp",
    );
    expectSelection(window, ["4"], ["Remove Seed"]);
  });

  test("keeps each saved picture's own card, and drops it by its remove button", () => {
    const window = installDom(
      ADMIN_TEMPLATES +
        sectionHtml(
          [storedImage(4, "Seed", ""), storedImage(5, "Other", "")],
          "/admin/listing/1/images",
        ),
    );
    initListingImages();

    requireElement<HTMLButtonElement>(
      window.document,
      '.listing-images-remove[aria-label="Remove Seed"]',
    ).click();

    expect(imageIdValues(window)).toEqual(["5"]);
    expect(
      attributesOf(window, "[data-sortable-handle]", "data-sortable-path"),
    ).toEqual(["/admin/listing/1/images/5"]);
  });

  test("refuses a stored picture whose id is not a positive number", () => {
    installDom(
      ADMIN_TEMPLATES +
        sectionHtml([storedImage(4, "Seed", "/image/seed-thumb.webp")]).replace(
          'value="4"',
          'value="abc"',
        ),
    );

    expect(() => initListingImages()).toThrow("invalid stored image id: abc");
  });

  test("keeps a stored picture without a thumbnail by its remove control", () => {
    const window = installDom(
      ADMIN_TEMPLATES + sectionHtml([storedImage(5, "No Thumb", "")]),
    );
    initListingImages();

    expect(
      window.document.querySelector(".listing-images-item img"),
    ).toBeNull();
    expectSelection(window, ["5"], ["Remove No Thumb"]);
  });

  test("adds the marked pictures in the order they were marked", async () => {
    const { dialog, window } = await mounted([twoImageList()]);

    const pressed = (): (string | null)[] =>
      attributesOf(window, ".md-image-option", "aria-pressed");
    expect(pressed()).toEqual(["false", "false"]);
    chose(window, "Zebra");
    expect(pressed()).toEqual(["false", "true"]);
    chose(window, "Alpha");
    // Marking a chosen picture again clears it; marking it once more adds it
    // back at the end of the order.
    chose(window, "Alpha");
    chose(window, "Alpha");
    confirmSelection(window);

    expect(dialog.open).toBe(false);
    expect(imageIdValues(window)).toEqual(["9", "2"]);
    expect(removeLabels(window)).toEqual(["Remove Zebra", "Remove Alpha"]);
  });

  test("drops a picture with its remove button", async () => {
    const { dialog, window } = await mounted([twoImageList()]);
    chose(window, "Zebra");
    chose(window, "Alpha");
    confirmSelection(window);
    expect(dialog.open).toBe(false);

    requireElement<HTMLButtonElement>(
      window.document,
      '.listing-images-remove[aria-label="Remove Zebra"]',
    ).click();

    expect(imageIdValues(window)).toEqual(["2"]);
  });

  test("keeps the window open and marks an uploaded picture", async () => {
    const { dialog, grid, window } = await mounted([
      twoImageList(),
      redirected("/admin/images/12/edit"),
      json({
        images: [
          {
            full: "/image/harbour.webp",
            id: 12,
            name: "Harbour",
            thumb: "/image/harbour-thumb.webp",
          },
        ],
      }),
    ]);

    await submitUpload(dialog, "Harbour");
    await flush();
    await untilReady(grid);

    expect(dialog.open).toBe(true);
    expect(optionByName(window, "Harbour").getAttribute("aria-pressed")).toBe(
      "true",
    );
    confirmSelection(window);

    expect(removeLabels(window)).toEqual(["Remove Harbour"]);
  });

  test("shows the empty note and disables confirm for an empty library", async () => {
    const { grid } = await mounted([json({ images: [] })]);

    expect(grid.textContent).toBe("No images yet.");
    expect(
      requireElement<HTMLButtonElement>(
        grid.closest(".md-image-picker")!,
        ".md-image-confirm",
      ).disabled,
    ).toBe(true);
  });

  test("keeps an uploaded picture the refreshed library has not listed", async () => {
    const window = await uploadHarbourAndConfirm(uploadToStaleLibrary());

    expectSelection(window, ["12"], ["Remove Harbour"]);
  });

  test("keeps an uploaded picture when the refreshed library fails", async () => {
    const window = await uploadHarbourAndConfirm([
      twoImageList(),
      redirected("/admin/images/12/edit"),
      new Response("down", { status: 500 }),
    ]);

    expectSelection(window, ["12"], ["Remove Harbour"]);
  });

  test("keeps the stored selection when the window closes without confirming", async () => {
    const { dialog, window } = await mounted(
      [twoImageList()],
      [storedImage(2, "Alpha", "/image/alpha-thumb.webp")],
    );

    expect(optionByName(window, "Alpha").getAttribute("aria-pressed")).toBe(
      "true",
    );
    optionByName(window, "Alpha").click();
    expect(optionByName(window, "Alpha").getAttribute("aria-pressed")).toBe(
      "false",
    );
    closeControl(dialog).click();
    expect(dialog.open).toBe(false);
    expect(imageIdValues(window)).toEqual(["2"]);

    part<HTMLButtonElement>(window, "[data-listing-images-trigger]").click();
    await untilReady(part<HTMLElement>(window, ".md-image-grid"));
    expect(optionByName(window, "Alpha").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("shows the load note and retries after the library fails", async () => {
    const { dialog, grid, window } = await mounted([
      new Response("down", { status: 500 }),
      twoImageList(),
    ]);

    expectLoadFailureThenClose(dialog, grid);

    part<HTMLButtonElement>(window, "[data-listing-images-trigger]").click();
    await untilReady(grid);
    expect(optionByName(window, "Alpha").textContent).toBe("Alpha");
  });

  test("leaves a section without the picker template inert", () => {
    const window = installDom(sectionHtml());
    initListingImages();

    requireElement<HTMLButtonElement>(
      window.document,
      "[data-listing-images-trigger]",
    ).click();
    assert(window.document.querySelector("dialog.admin-modal") === null);
  });

  test("uses the field's own heading as the window title", async () => {
    const { dialog, window } = await mounted([twoImageList()]);

    expect(
      requireElement<HTMLElement>(dialog, ".admin-modal-title").textContent,
    ).toBe(
      part<HTMLElement>(window, "[data-listing-images]").dataset
        .imagePickerHeading,
    );
  });

  test("raises the open window and keeps the draft when the trigger is pressed again", async () => {
    const { dialog, window } = await mounted([twoImageList()]);
    chose(window, "Zebra");

    part<HTMLButtonElement>(window, "[data-listing-images-trigger]").click();
    await flush();

    expect(window.document.querySelectorAll("dialog.admin-modal")).toHaveLength(
      1,
    );
    expect(dialog.open).toBe(true);
    expect(optionByName(window, "Zebra").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
