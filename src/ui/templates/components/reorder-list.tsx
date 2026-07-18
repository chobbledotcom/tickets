/**
 * Generic reorderable-list UI primitives shared by the admin collection pages
 * (questions, attributes): an empty-or-table helper, a reorderable detail-page
 * count table, and a full reorderable collection page shell.
 */

/* jscpd:ignore-start */
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { AdminSession } from "#shared/types.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import {
  type DataColumn,
  type ReorderColumnOptions,
  reorderTable,
} from "#templates/components/data-table.tsx";
import type { ReorderDirection } from "#templates/components/reorder.tsx";
/* jscpd:ignore-end */

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

const itemsOrEmptyReorderTable = <T,>(
  items: T[],
  emptyText: string,
  options: ReorderColumnOptions<T>,
  columns: readonly DataColumn<T>[],
): JSX.Element =>
  itemsOrEmptyNote(items, emptyText, (rows) =>
    reorderTable(options, columns, rows),
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
  itemsOrEmptyReorderTable(
    opts.items,
    opts.emptyText,
    { action: opts.moveAction, header: opts.orderLabel },
    [
      {
        cell: (item: T) =>
          isReadOnly() ? (
            opts.label(item)
          ) : (
            <a href={opts.editHref(item)}>{opts.label(item)}</a>
          ),
        header: opts.labelHeader,
      },
      {
        cell: (item: T) => opts.count(item),
        class: "quantity" as const,
        header: opts.countHeader,
      },
    ],
  );

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
  columns: readonly DataColumn<T>[];
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

      {itemsOrEmptyReorderTable(
        opts.items,
        opts.emptyText,
        {
          action: (item) => (direction) =>
            `${opts.basePath}/${item.id}/move-${direction}`,
          header: opts.orderLabel,
        },
        opts.columns,
      )}

      <GuideFooter href={opts.guideHref}>{opts.guideLabel}</GuideFooter>
    </>,
  );
