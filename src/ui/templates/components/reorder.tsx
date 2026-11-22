/**
 * Shared reorder controls for one row of an ordered list. The up arrow is a
 * tiny CSRF form that moves the row before the row above. The down arrow
 * moves it after the row below. The drag handle uses the same two routes.
 * The admin bundle shows it, and a drop names the row it lands next to.
 */

import { t } from "#i18n";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { MovePlace } from "#shared/reorder.ts";

/** The reorder inputs for one row: its path and its own anchor. It also
 *  holds the anchors of the rows above and below, which the ends lack. */
export type ReorderProps = {
  path: string;
  anchor: string;
  above: string | undefined;
  below: string | undefined;
};

/** The anchors of the rows above and below the row at `index`. */
export const neighbourAnchors = <T,>(
  rows: readonly T[],
  index: number,
  anchorOf: (row: T) => string,
): Pick<ReorderProps, "above" | "below"> => {
  const at = (position: number): string | undefined => {
    const row = rows[position];
    return row === undefined ? undefined : anchorOf(row);
  };
  return { above: at(index - 1), below: at(index + 1) };
};

/** The triangle glyph each arrow shows, keyed by where it moves the row. */
const ARROW_GLYPH: Record<MovePlace, string> = { after: "▼", before: "▲" };

/** The move route for one place. */
export const moveAction = (path: string, place: MovePlace): string =>
  `${path}/move-${place}`;

/** What one arrow needs: where it moves the row, and beside which row. */
type ArrowProps = {
  anchor: string;
  path: string;
  place: MovePlace;
  title?: string | undefined;
};

/** One arrow on its own: a tiny CSRF form that moves the row beside
 *  `anchor`. */
const ArrowForm = ({ anchor, path, place, title }: ArrowProps): JSX.Element => (
  <CsrfForm action={moveAction(path, place)} class="inline">
    <input name="anchor" type="hidden" value={anchor} />
    <button class="link-button small" title={title} type="submit">
      {ARROW_GLYPH[place]}
    </button>
  </CsrfForm>
);

/** One arrow inside a form that holds the row: a button that sends that
 *  form, with its CSRF token, to the move route instead. */
const ArrowButton = ({
  anchor,
  path,
  place,
  title,
}: ArrowProps): JSX.Element => (
  <button
    class="link-button small"
    formaction={moveAction(path, place)}
    name="anchor"
    title={title}
    type="submit"
    value={anchor}
  >
    {ARROW_GLYPH[place]}
  </button>
);

/** Where the row sits: on its own, or inside a form of its own (which a form
 *  of an arrow must not nest in). */
export type ReorderSetting = "alone" | "inForm";

const ARROW: Record<ReorderSetting, (props: ArrowProps) => JSX.Element> = {
  alone: ArrowForm,
  inForm: ArrowButton,
};

/** The drag handle and the arrows for one row. The handle stays hidden until
 * the admin bundle runs, so a page without scripts offers the arrows only. */
export const ReorderArrows = ({
  above,
  anchor,
  below,
  path,
  setting = "alone",
}: ReorderProps & { setting?: ReorderSetting }): JSX.Element => {
  const Arrow = ARROW[setting];
  return (
    <>
      <button
        class="reorder-handle"
        data-sortable-anchor={anchor}
        data-sortable-handle
        data-sortable-path={path}
        hidden
        tabindex="-1"
        title={t("common.reorder_handle")}
        type="button"
      >
        ⠿
      </button>
      {above !== undefined && (
        <Arrow
          anchor={above}
          path={path}
          place="before"
          title={t("common.reorder_up")}
        />
      )}{" "}
      {below !== undefined && (
        <Arrow
          anchor={below}
          path={path}
          place="after"
          title={t("common.reorder_down")}
        />
      )}
    </>
  );
};
