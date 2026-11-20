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

/** The stored image id, or a loud failure when the server value is wrong. */
const storedId = (value: string): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`invalid stored image id: ${value}`);
  }
  return id;
};

/** The stored choice a re-rendered hidden input carries. The server renders
 *  both data attributes beside the value. */
const choiceFromInput = (input: HTMLInputElement): ChosenImage => ({
  id: storedId(input.value),
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

/** The labels the server renders for the remove control. */
type RemoveLabels = {
  label: (name: string) => string;
  text: string;
};

/** One chosen picture: its thumbnail and the button that drops it. */
const chosenItem = (
  choice: ChosenImage,
  remove: (id: number) => void,
  labels: RemoveLabels,
): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = "listing-images-item";
  if (choice.thumb !== "") {
    item.append(createThumbnail(choice.thumb, "lazy"));
  }
  const button = createButton("listing-images-remove");
  button.textContent = labels.text;
  button.setAttribute("aria-label", labels.label(choice.name));
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
  const removeText = requireValue(
    section.dataset.imageRemoveText,
    "image remove text",
  );
  const removeLabel = requireValue(
    section.dataset.imageRemoveLabel,
    "image remove label",
  );
  const labels: RemoveLabels = {
    label: (name) => removeLabel.replace("{name}", () => name),
    text: removeText,
  };

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

  const reload = async (): Promise<boolean> => {
    fillGrid(grid, "loading", [noteFrom(template, "loading")]);
    try {
      loaded = await library.load();
    } catch {
      fillGrid(grid, "ready", [noteFrom(template, "loadFailed")]);
      confirm.disabled = draft.length === 0;
      return false;
    }
    draft = draft.map(
      (choice) => loaded.find((image) => image.id === choice.id) ?? choice,
    );
    renderGrid();
    return true;
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
    list.replaceChildren(
      ...chosen.map((choice) => chosenItem(choice, remove, labels)),
    );
    empty.hidden = chosen.length > 0;
    list.hidden = chosen.length === 0;
  };

  wireUploadForm(picker, async (choice) => {
    const uploaded = { ...choice, thumb: "" };
    draft = [...draft, uploaded];
    if (!(await reload())) {
      chosen = [...chosen, uploaded];
      render();
    }
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
