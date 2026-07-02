/**
 * Shared move-up / move-down reorder arrows: one tiny CSRF form per direction,
 * boundary-aware (no up arrow on the first row, no down arrow on the last).
 * The single implementation every reorderable admin table renders — each table
 * wraps it in its own cell (`<td>`, `<span class="reorder">`, …).
 */

import { CsrfForm } from "#shared/forms.tsx";

/** The arrows for the row at `index` of `count`. `action` builds the POST path
 * for a direction; `titles`, when given, adds a tooltip per arrow. */
export const ReorderArrows = ({
  action,
  index,
  count,
  titles,
}: {
  action: (direction: "up" | "down") => string;
  index: number;
  count: number;
  titles?: { up: string; down: string };
}): JSX.Element => (
  <>
    {index > 0 && (
      <CsrfForm action={action("up")} class="inline">
        <button class="link-button small" title={titles?.up} type="submit">
          &#9650;
        </button>
      </CsrfForm>
    )}{" "}
    {index < count - 1 && (
      <CsrfForm action={action("down")} class="inline">
        <button class="link-button small" title={titles?.down} type="submit">
          &#9660;
        </button>
      </CsrfForm>
    )}
  </>
);
