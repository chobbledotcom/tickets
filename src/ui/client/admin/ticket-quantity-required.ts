/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Block submission of the public ticket form when no tickets are selected.
 *
 * Mirrors the server-side check in processSubmission so users get immediate
 * feedback instead of a redirect that loses their typed contact details.
 *
 * Fails open: if anything unexpected happens the form is allowed through and
 * the server-side validation handles it. */
type QuantityInput = HTMLSelectElement | HTMLInputElement;

const selectedTicketQuantity = (inputs: NodeListOf<QuantityInput>): number => {
  let total = 0;
  for (const input of inputs) {
    const raw = input.value.trim();
    const value = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (Number.isSafeInteger(value) && value > 0) total += value;
  }
  return total;
};

export const initTicketQuantityRequired = (): void => {
  const forms = document.querySelectorAll<HTMLFormElement>("form");
  for (const form of forms) {
    const qtyInputs = form.querySelectorAll<QuantityInput>(
      '[name^="quantity_"], [name^="package_quantity_"]',
    );
    if (qtyInputs.length === 0) continue;

    let errorEl: HTMLDivElement | null = null;

    form.addEventListener("submit", (listing) => {
      if (selectedTicketQuantity(qtyInputs) > 0) return;

      listing.preventDefault();
      if (!errorEl) {
        errorEl = document.createElement("div");
        errorEl.className = "error";
        errorEl.setAttribute("role", "alert");
        errorEl.textContent = "Please select at least one ticket";
        form.insertBefore(errorEl, form.firstChild);
      }
      errorEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    for (const input of qtyInputs) {
      input.addEventListener("change", () => {
        if (errorEl) errorEl.remove();
        errorEl = null;
      });
    }
  }
};
