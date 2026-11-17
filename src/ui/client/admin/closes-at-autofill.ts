/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Auto-populate the closing time from the listing date when it is empty. */
export const initClosesAtAutofill = (): void => {
  const dateInput =
    document.querySelector<HTMLInputElement>('input[name="date"]');
  const closesAtInput = document.querySelector<HTMLInputElement>(
    'input[name="closesAt"]',
  );
  if (!dateInput || !closesAtInput) return;

  dateInput.addEventListener("change", () => {
    if (dateInput.value && !closesAtInput.value) {
      closesAtInput.value = dateInput.value;
    }
  });
};
