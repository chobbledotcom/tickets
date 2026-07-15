/**
 * Generic reorderable-list UI primitives shared by the admin collection pages
 * (questions, attributes): a right-aligned count cell, an empty-or-table
 * helper, a reorderable detail-page count table, and a full reorderable
 * collection page shell.
 */

/* jscpd:ignore-start */
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import type { ChildProps } from "#templates/components/child-props.ts";
import type { ReorderDirection } from "#templates/components/reorder.tsx";
import {
  ReorderLinkRow,
  ReorderTable,
  reorderLinkTableAt,
  writableReorderProps,
} from "#templates/components/reorder-table.tsx";
import { colClass } from "#templates/components/table-columns.ts";
/* jscpd:ignore-end */

/** A right-aligned quantity/count table cell — the `quantity`-classed `<td>`
 * the reorderable admin tables use for their trailing count column. */
export const QuantityCell = ({ children }: ChildProps): JSX.Element => (
  <td class={colClass("quantity")}>{children}</td>
);

/** Show the table (or whatever `whenPresent` builds) for a non-empty list, or
 * the plain "nothing yet" note the admin tables share when the list is empty. */
export const itemsOrEmptyNote = <T,>(
  items: T[],
  emptyText: string,
  whenPresent: (items: T[]) => JSX.Element,
): JSX.Element =>
  items.length === 0 ? (
    <p>
      <em>{emptyText}</em>
    </p>
  ) : (
    whenPresent(items)
  );

/** A reorderable detail-page table: a text column then a quantity column, each
 * row linking through to the item's own edit page, its move arrows posting to
 * the item's move routes, and ending in a count cell. Shows `emptyText` when
 * there are no items. Shared by the question answers table and the attribute
 * options table, which differ only in their headers, empty text, edit/move
 * routes, and count. */
export const reorderCountTable = <T extends { id: number }>(opts: {
  labelHeader: string;
  countHeader: string;
  orderLabel: string;
  items: T[];
  emptyText: string;
  moveAction: (item: T) => (direction: ReorderDirection) => string;
  editHref: (item: T) => string;
  label: (item: T) => Child;
  count: (item: T) => Child;
}): JSX.Element =>
  itemsOrEmptyNote(opts.items, opts.emptyText, (items) => (
    <ReorderTable
      columns={
        <>
          <th>{opts.labelHeader}</th>
          <th class={colClass("quantity")}>{opts.countHeader}</th>
        </>
      }
      orderLabel={opts.orderLabel}
      reorder={!isReadOnly()}
    >
      {items.map((item, index) => (
        <ReorderLinkRow
          action={opts.moveAction(item)}
          count={items.length}
          index={index}
          label={opts.label(item)}
          {...writableReorderProps(opts.editHref(item))}
        >
          <QuantityCell>{opts.count(item)}</QuantityCell>
        </ReorderLinkRow>
      ))}
    </ReorderTable>
  ));

/** A reorderable admin collection page: the "add new item" form (owner-only),
 * then either an empty note or the reorderable table of items, then the guide
 * footer — all inside the standard error-flash admin shell. Shared by the
 * questions and attributes list pages, which differ only in their labels,
 * columns, and per-row cells. */
export const reorderableListPage = <T extends { id: number }>(opts: {
  title: string;
  basePath: string;
  session: AdminSession;
  error: string | undefined;
  newFormId: string;
  addFormHtml: string;
  addLabel: string;
  items: T[];
  emptyText: string;
  orderLabel: string;
  columns: Child;
  rowLabel: (item: T) => Child;
  rowCells: (item: T) => Child;
  guideHref: string;
  guideLabel: Child;
}): string =>
  errorAdminPage(opts.title, opts.basePath)(opts.session, opts.error)(
    <>
      <WritableOnly>
        <CsrfForm action={opts.basePath} id={opts.newFormId}>
          <Raw html={opts.addFormHtml} />
          <SubmitButton icon="plus">{opts.addLabel}</SubmitButton>
        </CsrfForm>
      </WritableOnly>

      {itemsOrEmptyNote(opts.items, opts.emptyText, (items) =>
        reorderLinkTableAt(
          opts.basePath,
          opts.orderLabel,
          opts.columns,
          items,
          opts.rowLabel,
          opts.rowCells,
          !isReadOnly(),
        ),
      )}

      <GuideFooter href={opts.guideHref}>{opts.guideLabel}</GuideFooter>
    </>,
  );
