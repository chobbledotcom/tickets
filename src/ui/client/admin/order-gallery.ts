/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { stringEntries } from "#shared/string-entries.ts";

/** Live availability for the public order gallery.
 *
 * Without JS the gallery is a plain GET form (CSS-only cart) and availability
 * is settled on the booking page. This enhancement keeps the cards honest as
 * the visitor builds their order: on every change it asks
 * `GET /order/availability` (the same wire format the cart form submits) how
 * each card now stands, then greys out what no longer fits — showing "Remove
 * <name> to add" when the visitor's own earlier choice holds the contested
 * capacity — and nudges for a date when a chosen item needs one. It also
 * records the order things were added in (the hidden `order` field) so those
 * messages can honour the earliest choice.
 */

const REFRESH_DELAY_MS = 200;

/** Build the availability query from the form (checkboxes, date, order). */
const availabilityQuery = (form: HTMLFormElement): URLSearchParams =>
  new URLSearchParams(stringEntries(new FormData(form).entries()));

type CardState = { state: string; label: string };

type AvailabilityBody = {
  dateNeeded?: boolean;
  states?: Record<string, CardState>;
};

/** Ask the availability endpoint how each card stands beside the current
 * form state, or null on a non-OK answer. */
const fetchStates = async (
  form: HTMLFormElement,
  signal: AbortSignal,
): Promise<AvailabilityBody | null> => {
  const response = await fetch(
    `/order/availability?${availabilityQuery(form)}`,
    { signal },
  );
  return response.ok ? ((await response.json()) as AvailabilityBody) : null;
};

/** Record a card's (un)ticking in the added-order list and return the new
 * hidden-field value, or null when the change wasn't a card checkbox. */
const trackAddedOrder = (
  added: string[],
  target: EventTarget | null,
): string | null => {
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    return null;
  }
  const key = target.closest<HTMLElement>("[data-order-key]")?.dataset.orderKey;
  if (!key) return null;
  const at = added.indexOf(key);
  if (target.checked && at === -1) added.push(key);
  if (!target.checked && at !== -1) added.splice(at, 1);
  return added.join(",");
};

export const initOrderGallery = (): void => {
  const form = document.querySelector<HTMLFormElement>(
    "form[data-order-gallery]",
  );
  if (!form) return;
  const orderField = form.querySelector<HTMLInputElement>(
    'input[name="order"]',
  );
  const dateWrap = form.querySelector<HTMLElement>("[data-order-date]");
  const cards = [...form.querySelectorAll<HTMLElement>("[data-order-key]")];
  const added: string[] = [];

  const applyStates = (
    states: Record<string, CardState | undefined>,
    dateNeeded: boolean,
  ): void => {
    for (const card of cards) {
      // Cards are selected BY [data-order-key], so the key always exists.
      const info = states[card.dataset.orderKey!];
      const box = card.querySelector<HTMLInputElement>("input.order-select");
      if (!info || !box) continue;
      const label = card.querySelector<HTMLElement>("[data-order-state-label]");
      if (label) label.textContent = info.label;
      card.dataset.orderState = info.state;
      // A card that no longer fits can't be ticked — but a ticked card is
      // never locked, so the visitor can always change their mind.
      box.disabled =
        !box.checked &&
        (info.state === "blocked" || info.state === "unavailable");
    }
    dateWrap?.classList.toggle("order-date--needed", dateNeeded);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | null = null;
  const refresh = (): void => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      try {
        const data = await fetchStates(form, controller.signal);
        if (data !== null) {
          applyStates(data.states ?? {}, data.dateNeeded === true);
        }
      } catch {
        // Aborted or offline — the booking page re-checks availability anyway.
      }
    }, REFRESH_DELAY_MS);
  };

  form.addEventListener("change", (event) => {
    const orderValue = trackAddedOrder(added, event.target);
    if (orderValue !== null && orderField) orderField.value = orderValue;
    refresh();
  });
};
