/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Question visibility: show custom questions only when at least one
 * associated listing is active. Questions are tagged .custom-question.
 * Questions without data-listing-ids are always visible (single-listing pages).
 *
 * "Active" includes folded children. A question for a child listing shows, and
 * is required, while that child is chosen under an in-cart parent (see
 * selectedListingIds). The server enforces requiredness for the chosen child
 * only. This mirrors it in the browser, so the buyer sees the field to fill.
 *
 * A field for one ticket of one booking line carries `data-unit` and the
 * controls its line's quantity comes from (`data-sources`). It shows while the
 * line takes that ticket. A hidden one is disabled, so the form never posts
 * an answer for a ticket that the order does not take. */
import {
  namedControlQty,
  onSelectionChange,
  parentUnits,
  selectedListingIds,
  soleChildId,
} from "./child-selection.ts";

const FIELD_CONTROLS =
  'input[type="radio"], input[type="text"], textarea, select';

/** How many tickets one source gives a line: a listing's own quantity, a
 * package count times the member's fixed quantity, or a child's quantity under
 * one parent. A parent's sole child takes all of the parent's tickets. */
const sourceQty = (source: string): number => {
  const [kind = "", first = "", second = ""] = source.split(":");
  if (kind === "q") return namedControlQty(`quantity${first}`);
  if (kind === "p")
    return namedControlQty(`packageQuantity${first}`) * Number(second);
  return soleChildId(first) === second
    ? parentUnits(first)
    : namedControlQty(`childQty${first}_${second}`);
};

/** How many tickets a line takes: the sum of its sources. */
export const lineQuantity = (sources: string): number =>
  sources
    .split(" ")
    .filter((source) => source.length > 0)
    .reduce((total, source) => total + sourceQty(source), 0);

/** The text, choice and select controls of one field. */
const controlsOf = (field: HTMLElement) => [
  ...field.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(FIELD_CONTROLS),
];

/** Show a question while one of its listings is active. A ticket field inside
 * it keeps its own state, so its controls are left to {@link showTicket}. */
const showQuestion = (
  field: HTMLElement,
  active: Set<string>,
  ticketControls: ReadonlySet<Element>,
) => {
  const listingIds = field.dataset.listingIds!.split(" ");
  const hasSelected = listingIds.some((id) => active.has(id));
  field.hidden = !hasSelected;
  // Drop `required` while the question is hidden so a collapsed control
  // can't silently block form submission.
  for (const control of controlsOf(field)) {
    if (!ticketControls.has(control)) control.required = hasSelected;
  }
};

/** Show a ticket field while its line takes the ticket. */
const showTicket = (field: HTMLElement) => {
  const taken =
    lineQuantity(field.dataset.sources!) > Number(field.dataset.unit);
  field.hidden = !taken;
  for (const control of controlsOf(field)) {
    control.disabled = !taken;
    control.required = taken;
  }
};

export const initQuestionVisibility = (): void => {
  const questionFields = document.querySelectorAll<HTMLElement>(
    ".custom-question[data-listing-ids]",
  );
  const ticketFields = document.querySelectorAll<HTMLElement>(
    ".custom-question[data-unit]",
  );
  if (questionFields.length === 0 && ticketFields.length === 0) return;
  const ticketControls = new Set<Element>(
    [...ticketFields].flatMap(controlsOf),
  );

  const updateVisibility = () => {
    const active = selectedListingIds();
    for (const field of questionFields) {
      showQuestion(field, active, ticketControls);
    }
    for (const field of ticketFields) showTicket(field);
  };
  // Re-run whenever a quantity or per-parent child selection changes.
  onSelectionChange(updateVisibility);
  // Run on load to set initial state
  updateVisibility();
};
