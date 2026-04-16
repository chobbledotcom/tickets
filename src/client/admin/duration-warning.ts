/// <reference lib="dom" />
/** Event edit form: warn + gate save when booking duration changes, since
 * saving rewrites end_at on every existing booking for the event. */
export const initDurationWarning = (): void => {
  const form = document.getElementById("event-edit-form");
  const warn = document.getElementById("duration-warning");
  const confirm = document.getElementById(
    "duration-warning-confirm",
  ) as HTMLInputElement | null;
  const submit = document.getElementById(
    "event-edit-submit",
  ) as HTMLButtonElement | null;
  const input = form?.querySelector<HTMLInputElement>('[name="duration_days"]');
  const original = warn?.dataset.durationOriginal;
  if (!form || !warn || !confirm || !submit || !input || original === undefined)
    return;

  const update = (): void => {
    const changed = input.value !== original;
    warn.hidden = !changed;
    submit.disabled = changed && !confirm.checked;
  };
  input.addEventListener("input", update);
  confirm.addEventListener("change", update);
  update();
};
