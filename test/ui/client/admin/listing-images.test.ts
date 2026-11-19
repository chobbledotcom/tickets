/**
 * The Images field on a new listing (`src/ui/client/admin/listing-images.ts`):
 * the stored selection, the shared picker's multiple-choice flow, removal,
 * and the upload that keeps the dialog open.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import type { Window } from "happy-dom";
import { initListingImages } from "#src/ui/client/admin/listing-images.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { requireElement } from "#test-utils/happy-dom.ts";
import {
  cleanup,
  installDom,
  PICKER_TEMPLATE,
} from "#test-utils/markdown-editor-dom.ts";
import {
  flush,
  json,
  optionByName,
  redirected,
  submitUpload,
  twoImageList,
  untilReady,
} from "#test-utils/markdown-image-dialog.ts";

afterEach(cleanup);
afterEach(() => {
  fetchHolder.stub?.restore();
  fetchHolder.stub = undefined;
});

/** The stub outlives the test body's scope so the hook can restore it. */
const fetchHolder: { stub: Stub | undefined } = { stub: undefined };

const sectionHtml = (stored = ""): string => `
  <form action="/admin/listing" method="post">
    <fieldset data-image-picker-heading="Choose images" data-listing-images>
      <div data-listing-images-inputs>${stored}</div>
      <p data-listing-images-empty ${stored === "" ? "" : "hidden"}>
        No pictures chosen yet.
      </p>
      <ul data-listing-images-selected></ul>
      <button type="button" data-listing-images-trigger>Choose images</button>
    </fieldset>
  </form>`;

const storedInput = (id: number, name: string, thumb: string): string =>
  `<input type="hidden" name="imageIds" value="${id}" ` +
  `data-image-name="${name}" data-image-thumb="${thumb}">`;

/** The one element the selector names in this window. */
const part = <T extends Element>(window: Window, selector: string): T =>
  requireElement<T>(window.document, selector);

const mounted = async (
  replies: [FetchReply, ...FetchReply[]],
  stored = "",
): Promise<{
  dialog: HTMLDialogElement;
  grid: HTMLElement;
  window: Window;
}> => {
  fetchHolder.stub = stubFetch(...replies);
  const window = installDom(PICKER_TEMPLATE + sectionHtml(stored));
  initListingImages();
  part<HTMLButtonElement>(window, "[data-listing-images-trigger]").click();
  const dialog = part<HTMLDialogElement>(window, ".md-image-dialog");
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

/** Confirms the dialog's marked pictures into the form. */
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

describe("the listing images field", () => {
  test("renders the pictures a refused create carried", () => {
    const window = installDom(
      PICKER_TEMPLATE +
        sectionHtml(storedInput(4, "Seed", "/image/seed-thumb.webp")),
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
    expect(removeLabels(window)).toEqual(["Remove Seed"]);
  });

  test("keeps a stored picture without a thumbnail by its remove control", () => {
    const window = installDom(
      PICKER_TEMPLATE + sectionHtml(storedInput(5, "No Thumb", "")),
    );
    initListingImages();

    expect(
      window.document.querySelector(".listing-images-item img"),
    ).toBeNull();
    expect(removeLabels(window)).toEqual(["Remove No Thumb"]);
  });

  test("adds the marked pictures in the order they were marked", async () => {
    const { dialog, window } = await mounted([twoImageList()]);

    chose(window, "Zebra");
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
    dialog.close();

    requireElement<HTMLButtonElement>(
      window.document,
      '.listing-images-remove[aria-label="Remove Zebra"]',
    ).click();

    expect(imageIdValues(window)).toEqual(["2"]);
  });

  test("keeps the dialog open and marks an uploaded picture", async () => {
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

  test("ignores a second upload submit while one is in flight", async () => {
    const { dialog, window } = await mounted(uploadToStaleLibrary());
    const form = requireElement<HTMLFormElement>(dialog, ".md-image-upload");
    requireElement<HTMLInputElement>(form, 'input[name="name"]').value =
      "Harbour";

    form.requestSubmit();
    form.requestSubmit();
    await flush();

    confirmSelection(window);
    expect(imageIdValues(window)).toEqual(["12"]);
  });

  test("shows the empty note and disables confirm for an empty library", async () => {
    const { grid } = await mounted([json({ images: [] })]);

    expect(grid.textContent).toBe("No images yet.");
    expect(
      requireElement<HTMLButtonElement>(
        grid.closest("dialog")!,
        ".md-image-confirm",
      ).disabled,
    ).toBe(true);
  });

  test("keeps an uploaded picture the refreshed library has not listed", async () => {
    const { dialog, window } = await mounted(uploadToStaleLibrary());

    await submitUpload(dialog, "Harbour");
    await flush();

    confirmSelection(window);

    expect(imageIdValues(window)).toEqual(["12"]);
    expect(removeLabels(window)).toEqual(["Remove Harbour"]);
  });

  test("shows the upload note when the upload fails", async () => {
    const { dialog, grid } = await mounted([
      twoImageList(),
      new Response("refused", { status: 500 }),
    ]);

    await submitUpload(dialog, "Harbour");
    await flush();

    expect(grid.textContent).toContain(
      "The image could not be uploaded. Please try again.",
    );
  });

  test("leaves a section without the picker template inert", () => {
    const window = installDom(sectionHtml());
    initListingImages();

    requireElement<HTMLButtonElement>(
      window.document,
      "[data-listing-images-trigger]",
    ).click();
    assert(window.document.querySelector(".md-image-dialog") === null);
  });
});
