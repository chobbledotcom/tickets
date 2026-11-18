/**
 * The Images field on a new physical-product listing
 * (`src/ui/client/admin/listing-images.ts`): the stored selection, the shared
 * picker's multiple-choice flow, removal, and the upload that keeps the
 * dialog open.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import type { Window } from "happy-dom";
import { initListingImages } from "#src/ui/client/admin/listing-images.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import {
  createDomInstaller,
  fireEvent,
  requireElement,
} from "#test-utils/happy-dom.ts";
import {
  flush,
  json,
  redirected,
  twoImageList,
  untilReady,
} from "#test-utils/markdown-image-dialog.ts";

const { installDom, cleanup } = createDomInstaller();
afterEach(cleanup);

/** The stub outlives the test body's scope so the hook can restore it. */
const fetchHolder: { stub: Stub | undefined } = { stub: undefined };
afterEach(() => {
  fetchHolder.stub?.restore();
  fetchHolder.stub = undefined;
});

const sectionHtml = (stored = ""): string => `
  <form action="/admin/listing" method="post">
    <input type="hidden" name="csrfToken" value="token-1">
    <fieldset data-listing-images>
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

interface Mounted {
  dialog: HTMLDialogElement;
  grid: HTMLElement;
  window: Window;
}

const mounted = async (
  replies: [FetchReply, ...FetchReply[]],
  stored = "",
): Promise<Mounted> => {
  fetchHolder.stub = stubFetch(...replies);
  const window = installDom(sectionHtml(stored));
  initListingImages();
  const toolbar = requireElement<HTMLButtonElement>(
    window.document,
    "[data-listing-images-trigger]",
  );
  toolbar.click();
  const dialog = requireElement<HTMLDialogElement>(
    window.document,
    ".image-picker-dialog",
  );
  const grid = requireElement<HTMLElement>(
    window.document,
    ".image-picker-grid",
  );
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

/** The hidden image ids the field posts, in order. */
const imageIdValues = (window: Window): (string | null)[] =>
  attributesOf(window, 'input[name="imageIds"]', "value");

/** The chosen pictures' remove labels, in order. */
const removeLabels = (window: Window): (string | null)[] =>
  attributesOf(window, ".listing-images-remove", "aria-label");

/** The dialog's picture button whose visible name matches. */
const optionButton = (window: Window, name: string) => {
  const found = [
    ...window.document.querySelectorAll(".image-picker-option"),
  ].find((button) => button.textContent === name);
  if (found === undefined) throw new Error(`The dialog offers no ${name}`);
  return found;
};

const chose = (window: Window, name: string): void => {
  fireEvent(optionButton(window, name), new window.Event("click"));
};

describe("the listing images field", () => {
  test("renders the pictures a refused create carried", () => {
    const window = installDom(
      sectionHtml(storedInput(4, "Seed", "/image/seed-thumb.webp")),
    );
    initListingImages();

    const item = requireElement<HTMLLIElement>(
      window.document,
      ".listing-images-item",
    );
    expect(item.querySelector("span")).toBeNull();
    expect(
      item.querySelector(".listing-images-remove")?.getAttribute("aria-label"),
    ).toBe("Remove Seed");
    expect(item.querySelector("img")?.getAttribute("src")).toBe(
      "/image/seed-thumb.webp",
    );
    expect(
      requireElement<HTMLInputElement>(
        window.document,
        'input[name="imageIds"]',
      ).value,
    ).toBe("4");
  });

  test("keeps a stored picture without a thumbnail by its remove control", () => {
    const window = installDom(sectionHtml(storedInput(5, "No Thumb", "")));
    initListingImages();

    const item = requireElement<HTMLLIElement>(
      window.document,
      ".listing-images-item",
    );
    expect(item.querySelector("img")).toBeNull();
    expect(removeLabels(window)).toEqual(["Remove No Thumb"]);
  });

  test("keeps a stored picture that carries no name or thumbnail", () => {
    const window = installDom(
      sectionHtml('<input type="hidden" name="imageIds" value="6">'),
    );
    initListingImages();

    const item = requireElement<HTMLLIElement>(
      window.document,
      ".listing-images-item",
    );
    expect(item.querySelector("img")).toBeNull();
    expect(
      requireElement<HTMLInputElement>(
        window.document,
        'input[name="imageIds"]',
      ).value,
    ).toBe("6");
  });

  test("adds the marked pictures in the order they were marked", async () => {
    const { dialog, window } = await mounted([twoImageList()]);

    chose(window, "Zebra");
    chose(window, "Alpha");
    // Marking a chosen picture again clears it; marking it once more adds it
    // back at the end of the order.
    chose(window, "Alpha");
    chose(window, "Alpha");
    requireElement<HTMLButtonElement>(
      window.document,
      ".image-picker-confirm",
    ).click();

    expect(dialog.open).toBe(false);
    expect(imageIdValues(window)).toEqual(["9", "2"]);
    expect(removeLabels(window)).toEqual(["Remove Zebra", "Remove Alpha"]);
    expect(
      requireElement<HTMLElement>(
        window.document,
        "[data-listing-images-empty]",
      ).hidden,
    ).toBe(true);
  });

  test("drops a picture with its remove button", async () => {
    const { dialog, window } = await mounted([twoImageList()]);
    chose(window, "Zebra");
    chose(window, "Alpha");
    requireElement<HTMLButtonElement>(
      window.document,
      ".image-picker-confirm",
    ).click();
    dialog.close();

    requireElement<HTMLButtonElement>(
      window.document,
      '.listing-images-remove[aria-label="Remove Zebra"]',
    ).click();

    const ids = imageIdValues(window);
    expect(ids).toEqual(["2"]);
  });

  test("keeps the dialog open and marks an uploaded picture", async () => {
    const { dialog, grid, window } = await mounted([
      twoImageList(),
      redirected("/admin/images/12/edit"),
      json({
        images: [
          {
            id: 12,
            name: "Harbour",
            thumb: "/image/harbour-thumb.webp",
            url: "/image/harbour.webp",
          },
        ],
      }),
    ]);

    const form = requireElement<HTMLFormElement>(
      window.document,
      ".image-picker-upload",
    );
    requireElement<HTMLInputElement>(form, 'input[name="name"]').value =
      "Harbour";
    requireElement<HTMLButtonElement>(form, 'button[type="submit"]').click();
    await flush();
    await untilReady(grid);

    expect(dialog.open).toBe(true);
    expect(optionButton(window, "Harbour").getAttribute("aria-pressed")).toBe(
      "true",
    );
    requireElement<HTMLButtonElement>(
      window.document,
      ".image-picker-confirm",
    ).click();

    expect(removeLabels(window)).toEqual(["Remove Harbour"]);
  });

  test("leaves a section missing its parts alone", () => {
    const window = installDom(
      "<div data-listing-images><div data-listing-images-inputs></div></div>",
    );
    initListingImages();

    assert(window.document.querySelector(".image-picker-dialog") === null);
  });
});
