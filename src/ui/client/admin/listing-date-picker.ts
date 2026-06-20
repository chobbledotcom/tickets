/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Listing link date picker: filter date <select> options based on selected listing. */
export const initListingDatePicker = (): void => {
  const datesEl = document.getElementById("available-dates-data");
  const listingSelect = document.querySelector<HTMLSelectElement>(
    'select[name="listing_id"], #add_listing_id',
  );
  const dateField = document.querySelector<HTMLElement>(".daily-date-field");
  const dateSelect = document.querySelector<HTMLSelectElement>(
    'select[name="date"], #add_date',
  );
  if (!datesEl || !listingSelect || !dateField || !dateSelect) return;

  const datesData: Record<string, string[]> = JSON.parse(
    datesEl.textContent ?? "{}",
  );
  listingSelect.addEventListener("change", () => {
    const dates = datesData[listingSelect.value];
    if (dates && dates.length > 0) {
      dateField.style.display = "";
      dateSelect.innerHTML =
        '<option value="">Select date...</option>' +
        dates.map((d) => `<option value="${d}">${d}</option>`).join("");
      dateSelect.required = true;
    } else {
      dateField.style.display = "none";
      dateSelect.required = false;
      dateSelect.value = "";
    }
  });
};
