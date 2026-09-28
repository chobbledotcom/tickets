/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** The quantity ask a door gets when a scan covers a line that owes more
 * than one ticket: a select overlay above the page. Returns the chosen
 * ticket count, or null when the door cancelled. Shared by the camera
 * scanner and the manual check-in list, so both doors ask the same question
 * the same way. */
export const showQuantitySelect = (
  max: number,
  prompt: string,
  formatOption: (count: number) => string,
): Promise<number | null> => {
  const overlay = document.getElementById("scanner-quantity")!;
  const messageEl = document.getElementById("scanner-quantity-message")!;
  const select = document.getElementById(
    "scanner-quantity-select",
  ) as HTMLSelectElement;
  const confirmBtn = document.getElementById("scanner-quantity-confirm")!;
  const cancelBtn = document.getElementById("scanner-quantity-cancel")!;

  messageEl.textContent = prompt;
  select.replaceChildren(
    ...Array.from({ length: max }, (_, index) => {
      const count = index + 1;
      const option = document.createElement("option");
      option.value = String(count);
      option.textContent = formatOption(count);
      return option;
    }),
  );
  // The whole party is the common case, so it starts selected.
  select.value = String(max);

  const { promise, resolve } = Promise.withResolvers<number | null>();
  const cleanup = (value: number | null) => {
    confirmBtn.removeEventListener("click", onConfirm);
    cancelBtn.removeEventListener("click", onCancel);
    document.removeEventListener("keydown", onKeydown);
    overlay.classList.add("hidden");
    resolve(value);
  };
  const onConfirm = () => cleanup(Number(select.value));
  const onCancel = () => cleanup(null);
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") cleanup(null);
  };
  confirmBtn.addEventListener("click", onConfirm);
  cancelBtn.addEventListener("click", onCancel);
  document.addEventListener("keydown", onKeydown);
  overlay.classList.remove("hidden");
  select.focus();
  return promise;
};
