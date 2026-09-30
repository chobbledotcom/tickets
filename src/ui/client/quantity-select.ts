/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { askInTurn, askOverlay } from "#src/ui/client/confirm-dialog.ts";

/** The quantity ask a door gets when a scan covers a line that owes more
 * than one ticket: a select overlay above the page. Returns the chosen
 * ticket count, or null when the door cancelled. Shared by the camera
 * scanner and the manual check-in list, so both doors ask the same question
 * the same way. */
export const showQuantitySelect = (
  max: number,
  prompt: string,
  formatOption: (count: number) => string,
): Promise<number | null> =>
  askInTurn(() => {
    const select = document.getElementById(
      "scanner-quantity-select",
    ) as HTMLSelectElement;
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
    const answer = askOverlay<number | null>(
      "quantity",
      prompt,
      [
        ["scanner-quantity-confirm", () => Number(select.value)],
        ["scanner-quantity-cancel", () => null],
      ],
      null,
    );
    select.focus();
    return answer;
  });
