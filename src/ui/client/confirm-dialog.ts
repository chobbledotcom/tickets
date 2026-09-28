/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** The door scan's confirm dialog: asks before a force or an ID-verified
 * admit, and answers only through its buttons or the Escape key. */
export const showConfirm = (message: string): Promise<boolean> => {
  const overlay = document.getElementById("scanner-confirm")!;
  const msgEl = document.getElementById("scanner-confirm-message")!;
  const yesBtn = document.getElementById("scanner-confirm-yes")!;
  const noBtn = document.getElementById("scanner-confirm-no")!;
  const closeBtn = document.getElementById("scanner-confirm-close")!;

  msgEl.textContent = message;

  const { promise, resolve } = Promise.withResolvers<boolean>();
  const cleanup = (value: boolean) => {
    yesBtn.removeEventListener("click", onYes);
    noBtn.removeEventListener("click", onNo);
    closeBtn.removeEventListener("click", onClose);
    document.removeEventListener("keydown", onKeydown);
    overlay.classList.add("hidden");
    resolve(value);
  };
  const onYes = () => cleanup(true);
  const onNo = () => cleanup(false);
  const onClose = () => cleanup(false);
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup(false);
  };

  yesBtn.addEventListener("click", onYes);
  noBtn.addEventListener("click", onNo);
  closeBtn.addEventListener("click", onClose);
  document.addEventListener("keydown", onKeydown);
  overlay.classList.remove("hidden");
  return promise;
};
