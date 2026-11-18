/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The Images field on a new physical-product listing. It shows the chosen
 * pictures and keeps one `imageIds` hidden input for each picture. It opens
 * the shared image picker to choose or upload more.
 */

import type { ImagePickerOption } from "#shared/images/picker.ts";
import {
  createButton,
  createHiddenInput,
  createThumbnail,
  forEachMatch,
} from "#src/ui/client/dom.ts";
import { createImagePicker } from "./image-picker.ts";

const REMOVE_MESSAGE = "Remove";

/** The stored choice a re-rendered hidden input carries. */
const choiceFromInput = (input: HTMLInputElement): ImagePickerOption => ({
  id: Number(input.value),
  name: input.dataset.imageName ?? "",
  thumb: input.dataset.imageThumb ?? "",
  url: "",
});

/** The hidden input that posts one chosen picture. */
const choiceInput = (choice: ImagePickerOption): HTMLInputElement => {
  const input = createHiddenInput("imageIds", String(choice.id));
  input.dataset.imageName = choice.name;
  input.dataset.imageThumb = choice.thumb;
  return input;
};

/** One chosen picture: its thumbnail and the button that drops it. */
const chosenItem = (
  choice: ImagePickerOption,
  remove: (id: number) => void,
): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = "listing-images-item";
  item.dataset.imageId = String(choice.id);
  if (choice.thumb !== "") {
    item.append(createThumbnail(choice.thumb, "lazy"));
  }
  const button = createButton("listing-images-remove");
  button.textContent = REMOVE_MESSAGE;
  button.setAttribute("aria-label", `Remove ${choice.name}`);
  button.addEventListener("click", () => remove(choice.id));
  item.append(button);
  return item;
};

const setUpListingImages = (section: HTMLElement): void => {
  const part = (selector: string): HTMLElement | null =>
    section.querySelector<HTMLElement>(selector);
  const inputs = part("[data-listing-images-inputs]");
  const list = part("[data-listing-images-selected]");
  const empty = part("[data-listing-images-empty]");
  const trigger = part("[data-listing-images-trigger]");
  // The field is server-rendered as one block. A page that carries only part
  // of it is not this control's page, so leave it alone.
  if (inputs === null || list === null || empty === null || trigger === null) {
    return;
  }

  const stored = inputs.querySelectorAll<HTMLInputElement>(
    'input[name="imageIds"]',
  );
  let chosen = [...stored].map(choiceFromInput);

  const remove = (id: number): void => {
    chosen = chosen.filter((choice) => choice.id !== id);
    render();
  };

  const render = (): void => {
    inputs.replaceChildren(...chosen.map(choiceInput));
    list.replaceChildren(...chosen.map((choice) => chosenItem(choice, remove)));
    empty.hidden = chosen.length > 0;
    list.hidden = chosen.length === 0;
  };

  const picker = createImagePicker({
    csrfSource: trigger,
    mode: "multiple",
    mount: section,
    onChoose: (options) => {
      chosen = [...options];
      render();
    },
    selected: () => chosen,
    title: "Choose images",
  });
  trigger.addEventListener("click", () => picker.open());
  render();
};

/** Enhance every Images field on the page. */
export const initListingImages = (): void => {
  forEachMatch<HTMLElement>("[data-listing-images]", setUpListingImages);
};
