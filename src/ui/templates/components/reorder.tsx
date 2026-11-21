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

/** The triangle glyph each arrow shows, keyed by where it moves the row. */
const ARROW_GLYPH: Record<MovePlace, string> = { after: "▼", before: "▲" };

/** The move route for one place. */
export const moveAction = (path: string, place: MovePlace): string =>
  `${path}/move-${place}`;

/** One arrow: a tiny CSRF form that moves the row beside `anchor`. */
const ArrowForm = ({
  anchor,
  path,
  place,
  title,
}: {
  anchor: string;
  path: string;
  place: MovePlace;
  title?: string | undefined;
}): JSX.Element => (
  <CsrfForm action={moveAction(path, place)} class="inline">
    <input name="anchor" type="hidden" value={anchor} />
    <button class="link-button small" title={title} type="submit">
      {ARROW_GLYPH[place]}
    </button>
  </CsrfForm>
);

/** The drag handle and the arrows for one row. `titles`, when given, adds a
 * tooltip per arrow. The handle stays hidden until the admin bundle runs, so
 * a page without scripts offers the arrows only. */
export const ReorderArrows = ({
  above,
  anchor,
  below,
  path,
  titles,
}: ReorderProps & {
  titles?: Readonly<Record<MovePlace, string>> | undefined;
}): JSX.Element => (
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
      <ArrowForm
        anchor={above}
        path={path}
        place="before"
        title={titles?.before}
      />
    )}{" "}
    {below !== undefined && (
      <ArrowForm
        anchor={below}
        path={path}
        place="after"
        title={titles?.after}
      />
    )}
  </>
);
