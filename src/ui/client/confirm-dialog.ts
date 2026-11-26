/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { requiredById } from "./dom.ts";

/** The turn of the question now showing, or of the last one answered. One
 * queue serves every dialog on the door. A dialog that fails leaves the
 * turn failed, so every later ask on that broken page throws the same way
 * instead of hanging the door. The first question waits for nothing. */
const turn: { last: Promise<unknown> } = { last: Promise.resolve() };

/** Open one door question once every earlier one is answered. The camera
 * loop and the manual form share the door's dialogs, so questions queue one
 * behind the other. A single click answers exactly the prompt the operator
 * sees. It never answers a hidden second question. */
export const askInTurn = <T>(open: () => Promise<T>): Promise<T> => {
  const waitFor = turn.last;
  const answer = (async () => {
    await waitFor;
    return open();
  })();
  turn.last = answer;
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
  const overlay = requiredById(`scanner-${name}`);
  requiredById(`scanner-${name}-message`).textContent = message;
  const buttons = answers.map(
    ([id, answer]) => [requiredById(id), () => finish(answer())] as const,
  );
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") finish(escaped);
  };
  const { promise, resolve } = Promise.withResolvers<T>();
  // One abort signal owns every handler this overlay adds, so the answer takes
  // them all away and the next open starts clean.
  const listeners = new AbortController();
  const finish = (value: T) => {
    listeners.abort();
    overlay.classList.add("hidden");
    resolve(value);
  };
  for (const [button, onClick] of buttons) {
    button.addEventListener("click", onClick, { signal: listeners.signal });
  }
  document.addEventListener("keydown", onKeydown, { signal: listeners.signal });
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
