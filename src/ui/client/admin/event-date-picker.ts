/// <reference lib="dom" />
/** Event link date picker: filter date <select> options based on selected event. */
export const initEventDatePicker = (): void => {
  const datesEl = document.getElementById("available-dates-data");
  const eventSelect = document.querySelector<HTMLSelectElement>(
    'select[name="event_id"], #add_event_id',
  );
  const dateField = document.querySelector<HTMLElement>(".daily-date-field");
  const dateSelect = document.querySelector<HTMLSelectElement>(
    'select[name="date"], #add_date',
  );
  if (!datesEl || !eventSelect || !dateField || !dateSelect) return;

  const datesData: Record<string, string[]> = JSON.parse(
    datesEl.textContent ?? "{}",
  );
  eventSelect.addEventListener("change", () => {
    const dates = datesData[eventSelect.value];
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
