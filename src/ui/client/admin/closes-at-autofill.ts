/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Auto-populate closes_at from listing date when closes_at is empty. */
export const initClosesAtAutofill = (): void => {
  const dateInput =
    document.querySelector<HTMLInputElement>('input[name="date"]');
  const closesAtInput = document.querySelector<HTMLInputElement>(
    'input[name="closes_at"]',
  );
  if (!dateInput || !closesAtInput) return;

  dateInput.addEventListener("change", () => {
    if (dateInput.value && !closesAtInput.value) {
      closesAtInput.value = dateInput.value;
    }
  });
};
