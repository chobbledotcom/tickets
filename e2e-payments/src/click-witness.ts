/**
 * The page-side click witness for replay-safe acting: it answers whether a
 * click may have dispatched, so a failed action is replayed only when the
 * witness proves the first attempt never reached the page. The actability
 * predicate lives here too: the witnessed attempt and the DOM fallback both
 * gate on it.
 */

import type { Locator } from "playwright";

/** Whether the control can honestly be acted on at all. */
export const interactable = async (locator: Locator): Promise<boolean> =>
  (await locator.isVisible()) && (await locator.isEnabled());

/** The page-side shape the click witness stamps onto a control. */
type Witnessed = {
  __e2eClickSeen?: boolean;
  addEventListener: (
    type: string,
    listener: () => void,
    options: { capture: boolean; once: boolean },
  ) => void;
};

/** Arm a page-side click witness on the control. The returned question is
 * whether the click may have dispatched — and a witness that cannot answer
 * (the element or its document is already gone, which navigation after a
 * dispatched submission causes) says yes, never "safe to replay". */
const armClickWitness = async (
  control: Locator,
): Promise<() => Promise<boolean>> => {
  const armed = await control
    .evaluate((element) => {
      const witnessed = element as unknown as Witnessed;
      witnessed.__e2eClickSeen = false;
      witnessed.addEventListener(
        "click",
        () => {
          witnessed.__e2eClickSeen = true;
        },
        { capture: true, once: true },
      );
    })
    .then(() => true)
    .catch(() => false);
  return () =>
    armed
      ? control
          .evaluate(
            (element) =>
              (element as unknown as Witnessed).__e2eClickSeen !== false,
          )
          .catch(() => true)
      : Promise.resolve(true);
};

/** Arm the click witness and return the attempt that runs an ordinary action
 * under it: true when the action finished, false only for the one
 * replay-safe failure — the witness proves the click never dispatched and
 * the control is still interactable. Every other failure rethrows: replaying
 * a dispatched submission would act twice, and a second POST on a live
 * refund form moves real money. */
export const armWitnessedAttempt = async (
  control: Locator,
): Promise<(ordinary: () => Promise<void>) => Promise<boolean>> => {
  const mayHaveDispatched = await armClickWitness(control);
  return async (ordinary) => {
    try {
      await ordinary();
      return true;
    } catch (error) {
      if (await mayHaveDispatched()) throw error;
      if (!(await interactable(control))) throw error;
      return false;
    }
  };
};
