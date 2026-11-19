/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The Images field on a new physical-product or custom listing. It shows the
 * chosen pictures and keeps one `imageIds` hidden input for each picture. It
 * opens the shared image picker to choose or upload more.
 */

import type { ChosenImage, ImageOption } from "#shared/images/picker.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  createButton,
  createHiddenInput,
  createThumbnail,
  forEachMatch,
  requiredChild,
} from "#src/ui/client/dom.ts";
import {
  clonePickerDialog,
  fillGrid,
  imageOptionNodes,
  noteFrom,
  optionButton,
  pickerTemplateOrNull,
  wireDialogClose,
  wireUploadForm,
} from "./image-picker-template.ts";
import { createImageLibrary } from "./markdown-editor-image-view.ts";

const REMOVE_MESSAGE = "Remove";

/** The stored choice a re-rendered hidden input carries. The server renders
 *  both data attributes beside the value. */
const choiceFromInput = (input: HTMLInputElement): ChosenImage => ({
  id: Number(input.value),
  name: requireValue(input.dataset.imageName, "chosen image name"),
  thumb: requireValue(input.dataset.imageThumb, "chosen image thumbnail"),
});

/** The hidden input that posts one chosen picture. */
const choiceInput = (choice: ChosenImage): HTMLInputElement => {
  const input = createHiddenInput("imageIds", String(choice.id));
  input.dataset.imageName = choice.name;
  input.dataset.imageThumb = choice.thumb;
  return input;
};

const thumbnail = (src: string): HTMLImageElement =>
  createThumbnail(src, "lazy");

/** One chosen picture: its thumbnail and the button that drops it. */
const chosenItem = (
  choice: ChosenImage,
  remove: (id: number) => void,
): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = "listing-images-item";
  item.dataset.imageId = String(choice.id);
  if (choice.thumb !== "") {
    item.append(thumbnail(choice.thumb));
  }
  const button = createButton("listing-images-remove");
  button.textContent = REMOVE_MESSAGE;
  button.setAttribute("aria-label", `Remove ${choice.name}`);
  button.addEventListener("click", () => remove(choice.id));
  item.append(button);
  return item;
};

const setUpListingImages = (section: HTMLElement): void => {
  const inputs = requiredChild<HTMLElement>(
    section,
    "[data-listing-images-inputs]",
  );
  const list = requiredChild<HTMLElement>(
    section,
    "[data-listing-images-selected]",
  );
  const empty = requiredChild<HTMLElement>(
    section,
    "[data-listing-images-empty]",
  );
  const trigger = requiredChild<HTMLButtonElement>(
    section,
    "[data-listing-images-trigger]",
  );
  const template = pickerTemplateOrNull();
  if (template === null) return;

  const stored = inputs.querySelectorAll<HTMLInputElement>(
    'input[name="imageIds"]',
  );
  let chosen = [...stored].map(choiceFromInput);
  const library = createImageLibrary();
  const picker = clonePickerDialog(template, section);
  const { dialog, grid } = picker;
  const confirm = requiredChild<HTMLButtonElement>(dialog, ".md-image-confirm");
  confirm.hidden = false;
  const heading = requiredChild<HTMLHeadingElement>(dialog, "h2");
  heading.textContent = requireValue(
    section.dataset.imagePickerHeading,
    "image picker heading",
  );

  // The dialog marks pictures in a draft. The form changes only when the
  // operator confirms, so a close leaves the stored selection as it was.
  let draft: ChosenImage[] = [];
  let loaded: ImageOption[] = [];

  const isChosen = (id: number): boolean =>
    draft.some((option) => option.id === id);

  const renderGrid = (): void => {
    fillGrid(
      grid,
      "ready",
      imageOptionNodes(template, loaded, (option, index) =>
        optionButton(option, index, () => toggle(option), isChosen(option.id)),
      ),
    );
    confirm.disabled = draft.length === 0;
  };

  const toggle = (option: ImageOption): void => {
    draft = isChosen(option.id)
      ? draft.filter((carried) => carried.id !== option.id)
      : [...draft, option];
    renderGrid();
  };

  const reload = async (): Promise<void> => {
    fillGrid(grid, "loading", [noteFrom(template, "loading")]);
    loaded = await library.load();
    draft = draft.map(
      (choice) => loaded.find((image) => image.id === choice.id) ?? choice,
    );
    renderGrid();
  };

  const open = async (): Promise<void> => {
    draft = [...chosen];
    fillGrid(grid, "loading", [noteFrom(template, "loading")]);
    dialog.showModal();
    await reload();
  };

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

  wireUploadForm(picker, {
    forgetLibrary: library.forget,
    onUploaded: async (choice) => {
      draft = [...draft, { ...choice, thumb: "" }];
      await reload();
    },
  });

  confirm.addEventListener("click", () => {
    chosen = [...draft];
    render();
    dialog.close();
  });
  wireDialogClose(dialog, () => trigger.focus());
  trigger.addEventListener("click", () => void open());
  render();
};

/** Enhance every Images field on the page. */
export const initListingImages = (): void => {
  forEachMatch<HTMLElement>("[data-listing-images]", setUpListingImages);
};
