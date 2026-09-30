/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/** The turn of the question now showing, or the last one answered. A dialog
 * that fails leaves the turn failed, so every later ask on that broken page
 * throws the same way instead of hanging the door. Kept in a closure so the
 * browser bundle takes on no module state beyond this one dialog. */
const queue = (() => {
  let turn: Promise<unknown> = Promise.resolve();
  return {
    pass: (next: Promise<unknown>): void => {
      turn = next;
    },
    wait: (): Promise<unknown> => turn,
  };
})();

/** Open one door question once every earlier one is answered. The camera
 * loop and the manual form share the door's dialogs, so questions queue one
 * behind the other, and a single click answers exactly the prompt the
 * operator sees, never a hidden second question. */
export const askInTurn = <T>(open: () => Promise<T>): Promise<T> => {
  const answer = (async () => {
    await queue.wait();
    return open();
  })();
  queue.pass(answer);
  return answer;
};

/** One door overlay's answer: each button resolves to its own value, and
 * the Escape key resolves to `escaped`. The overlay shows `message` while it
 * waits, and hides again once answered. */
export const askOverlay = <T>(
  name: string,
  message: string,
  answers: readonly [id: string, answer: () => T][],
  escaped: T,
): Promise<T> => {
  const overlay = document.getElementById(`scanner-${name}`)!;
  document.getElementById(`scanner-${name}-message`)!.textContent = message;
  const buttons = answers.map(
    ([id, answer]) =>
      [document.getElementById(id)!, () => finish(answer())] as const,
  );
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") finish(escaped);
  };
  const { promise, resolve } = Promise.withResolvers<T>();
  const finish = (value: T) => {
    for (const [button, onClick] of buttons) {
      button.removeEventListener("click", onClick);
    }
    document.removeEventListener("keydown", onKeydown);
    overlay.classList.add("hidden");
    resolve(value);
  };
  for (const [button, onClick] of buttons) {
    button.addEventListener("click", onClick);
  }
  document.addEventListener("keydown", onKeydown);
  overlay.classList.remove("hidden");
  return promise;
};

/** The door scan's confirm dialog: asks before a force or an ID-verified
 * admit, and answers only through its buttons or the Escape key. */
export const showConfirm = (message: string): Promise<boolean> =>
  askInTurn(() =>
    askOverlay(
      "confirm",
      message,
      [
        ["scanner-confirm-yes", () => true],
        ["scanner-confirm-no", () => false],
        ["scanner-confirm-close", () => false],
      ],
      false,
    ),
  );
