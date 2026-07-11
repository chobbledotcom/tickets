/**
 * Shared move-up / move-down reorder arrows: one tiny CSRF form per direction,
 * boundary-aware (no up arrow on the first row, no down arrow on the last).
 * The single implementation every reorderable admin table renders — each table
 * wraps it in its own cell (`<td>`, `<span class="reorder">`, …).
 */

import { CsrfForm } from "#shared/forms.tsx";

/** The reorder inputs shared by {@link ReorderArrows} and the per-table cells
 *  that wrap it (e.g. `ReorderControls` in questions.tsx): a direction-to-path
 *  builder plus the row's `index` within `count` rows. */
export type ReorderDirection = "up" | "down";

export type ReorderProps = {
  action: (direction: ReorderDirection) => string;
  index: number;
  count: number;
};

/** The triangle glyph rendered on each direction's arrow button. */
const ARROW_GLYPH = { down: "▼", up: "▲" } as const;

/** One direction's reorder button — a tiny inline CSRF form. Rendered only
 *  when the row can actually move that way (see {@link ReorderArrows}). */
const ArrowButton = ({
  action,
  direction,
  title,
}: {
  action: (direction: ReorderDirection) => string;
  direction: ReorderDirection;
  title?: string | undefined;
}): JSX.Element => (
  <CsrfForm action={action(direction)} class="inline">
    <button class="link-button small" title={title} type="submit">
      {ARROW_GLYPH[direction]}
    </button>
  </CsrfForm>
);

/** The arrows for the row at `index` of `count`. `action` builds the POST path
 * for a direction; `titles`, when given, adds a tooltip per arrow. */
export const ReorderArrows = ({
  action,
  index,
  count,
  titles,
}: ReorderProps & {
  titles?: { up: string; down: string };
}): JSX.Element => (
  <>
    {index > 0 && (
      <ArrowButton action={action} direction="up" title={titles?.up} />
    )}{" "}
    {index < count - 1 && (
      <ArrowButton action={action} direction="down" title={titles?.down} />
    )}
  </>
);
