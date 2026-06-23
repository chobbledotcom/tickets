/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Booking-form running total.
 *
 * Progressively enhances the "show total" button — which, without JS, POSTs the
 * booking inputs to /calculate and opens the rendered summary in a new tab —
 * into an inline fetch that drops the summary into the page and re-runs whenever
 * the form changes. PII fields are stripped from the request: a quote only needs
 * the pricing inputs, and the server ignores contact details anyway. */

const PII_FIELDS = [
  "name",
  "email",
  "phone",
  "address",
  "special_instructions",
];

const RECALC_DELAY_MS = 250;

/** Build the request body from the form, dropping PII and file entries. */
const pricingBody = (form: HTMLFormElement): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === "string" && !PII_FIELDS.includes(key)) {
      params.append(key, value);
    }
  }
  return params;
};

export const initRunningTotal = (): void => {
  const button = document.querySelector<HTMLButtonElement>(
    "[data-running-total]",
  );
  const output = document.querySelector<HTMLElement>(
    "[data-running-total-output]",
  );
  const form = button?.form;
  if (!button || !output || !form) return;

  // The calculate endpoint to post to (the button's no-JS new-tab target).
  const action = button.formAction;
  // Take over the form submit: render inline instead of opening a new tab.
  // With JS the total updates live, so the button is redundant — hide it via
  // the shared .hidden class and show the inline summary instead, one or the
  // other rather than both.
  button.type = "button";
  button.classList.add("hidden");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let queued = false;

  const render = async (): Promise<void> => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const response = await fetch(action, {
        body: pricingBody(form),
        method: "POST",
      });
      output.innerHTML = await response.text();
    } catch {
      // A network hiccup leaves the previous total in place rather than
      // flashing an error mid-typing.
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void render();
      }
    }
  };

  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(render, RECALC_DELAY_MS);
  };

  form.addEventListener("input", schedule);
  form.addEventListener("change", schedule);
  void render();
};
