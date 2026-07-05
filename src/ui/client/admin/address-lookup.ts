/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Postcode address search — progressive enhancement for address textareas.
 *
 * When a lookup provider is configured the server renders a hidden panel
 * (all copy lives in its markup and data attributes) directly above the
 * address textarea; this script reveals the panel and wires it to the
 * same-origin GET /address-lookup endpoint, so the provider API key never
 * reaches the browser. Searching fills a select with the returned address
 * lines and choosing one fills the textarea.
 *
 * Modes ("data-address-lookup"): "locked" (public booking form) makes the
 * textarea read-only until the Edit button — or a submit with no address —
 * unlocks it; "editable" (admin attendee forms) leaves it always editable.
 */

const ENDPOINT = "/address-lookup";

type LookupResponse = { addresses?: string[]; error?: string };

type PanelParts = {
  panel: HTMLElement;
  searchInput: HTMLInputElement;
  findButton: HTMLButtonElement;
  resultsLabel: HTMLElement;
  select: HTMLSelectElement;
  status: HTMLElement;
  editButton: HTMLButtonElement | null;
  textarea: HTMLTextAreaElement;
};

/** Show a status message under the search box ("" hides it). */
const setStatus = (status: HTMLElement, message: string): void => {
  status.textContent = message;
  status.hidden = message === "";
};

/** Read one of the panel's server-rendered copy strings. */
const panelText = (panel: HTMLElement, key: string): string =>
  panel.dataset[key] ?? "";

/** Build one <option> (textContent assignment keeps the line inert). */
const addressOption = (line: string): HTMLOptionElement => {
  const option = document.createElement("option") as HTMLOptionElement;
  option.value = line;
  option.textContent = line;
  return option;
};

/** The disabled "Select an address…" placeholder heading the options. */
const placeholderOption = (panel: HTMLElement): HTMLOptionElement => {
  const option = addressOption(panelText(panel, "placeholder"));
  option.value = "";
  return option;
};

/** Render a completed search: options into the select, or a "none found"
 *  status when the provider had no addresses for the search. */
const showResults = (parts: PanelParts, addresses: string[]): void => {
  const { panel, resultsLabel, select, status } = parts;
  if (addresses.length === 0) {
    setStatus(status, panelText(panel, "noResults"));
    return;
  }
  select.replaceChildren(
    placeholderOption(panel),
    ...addresses.map(addressOption),
  );
  resultsLabel.hidden = false;
  setStatus(status, "");
};

/** Run one search against the lookup endpoint. */
const search = async (parts: PanelParts): Promise<void> => {
  const { panel, resultsLabel, searchInput, status } = parts;
  const query = searchInput.value.trim();
  if (!query) return;
  resultsLabel.hidden = true;
  setStatus(status, panelText(panel, "searching"));
  try {
    const response = await fetch(
      `${ENDPOINT}?search=${encodeURIComponent(query)}`,
      { credentials: "same-origin" },
    );
    const data = (await response.json()) as LookupResponse;
    if (!response.ok || !data.addresses) {
      setStatus(status, data.error || panelText(panel, "error"));
      return;
    }
    showResults(parts, data.addresses);
  } catch {
    setStatus(status, panelText(panel, "error"));
  }
};

/** Lock the textarea behind the Edit button (public booking form). */
const lockTextarea = (parts: PanelParts): void => {
  const { editButton, textarea } = parts;
  if (!editButton) return;
  textarea.readOnly = true;
  editButton.hidden = false;
  const unlock = (): void => {
    textarea.readOnly = false;
    editButton.hidden = true;
  };
  editButton.addEventListener("click", () => {
    unlock();
    textarea.focus();
  });
  // A read-only textarea skips native required validation, so an untouched
  // form could submit an empty address. Unlock and resubmit instead: the
  // second pass runs native validation against the now-editable textarea.
  textarea.form?.addEventListener("submit", (event) => {
    if (!textarea.readOnly || textarea.value.trim() !== "") return;
    event.preventDefault();
    unlock();
    textarea.form?.requestSubmit();
  });
};

/** Find the panel's controls and its form's address textarea. */
const collectParts = (panel: HTMLElement): PanelParts | null => {
  const searchInput = panel.querySelector<HTMLInputElement>(
    "[data-address-search]",
  );
  const findButton = panel.querySelector<HTMLButtonElement>(
    "[data-address-find]",
  );
  const resultsLabel = panel.querySelector<HTMLElement>(
    "[data-address-results-label]",
  );
  const select = panel.querySelector<HTMLSelectElement>(
    "[data-address-results]",
  );
  const status = panel.querySelector<HTMLElement>("[data-address-status]");
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="address"]',
  );
  if (!searchInput || !findButton || !resultsLabel || !select || !status) {
    return null;
  }
  if (!textarea) return null;
  return {
    editButton: panel.querySelector<HTMLButtonElement>("[data-address-edit]"),
    findButton,
    panel,
    resultsLabel,
    searchInput,
    select,
    status,
    textarea,
  };
};

/** Reveal one panel and wire its search, selection, and edit behaviors. */
const setupPanel = (panel: HTMLElement): void => {
  const parts = collectParts(panel);
  if (!parts) return;
  const { findButton, searchInput, select, textarea } = parts;
  panel.hidden = false;
  if (panel.dataset.addressLookup === "locked") lockTextarea(parts);
  findButton.addEventListener("click", () => void search(parts));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void search(parts);
  });
  select.addEventListener("change", () => {
    if (!select.value) return;
    textarea.value = select.value;
  });
};

/** Boot every address-lookup panel on the page. */
export const initAddressLookup = (): void => {
  for (const panel of document.querySelectorAll<HTMLElement>(
    "[data-address-lookup]",
  )) {
    setupPanel(panel);
  }
};
