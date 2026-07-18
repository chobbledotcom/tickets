import type { Child } from "#jsx/jsx-runtime.ts";
import { isReadOnly } from "#shared/env.ts";
import type { DataColumn } from "#templates/components/data-table.tsx";
import {
  ReorderArrows,
  type ReorderProps,
} from "#templates/components/reorder.tsx";
import { colClass } from "#templates/components/table-columns.ts";

type ReorderArrowProps = ReorderProps & {
  titles?: { down: string; up: string };
};

const ReorderCell = (props: ReorderArrowProps): JSX.Element => (
  <td class={colClass("reorder")}>
    <ReorderArrows {...props} />
  </td>
);

/** The reorder column for a schema-driven data table. */
export const reorderColumn = <T,>(opts: {
  action: (item: T) => ReorderProps["action"];
  header: Child;
  titles?: ReorderArrowProps["titles"];
}): DataColumn<T> => ({
  cell: (item, index, items) =>
    isReadOnly() ? null : (
      <ReorderArrows
        action={opts.action(item)}
        count={items.length}
        index={index}
        {...(opts.titles ? { titles: opts.titles } : {})}
      />
    ),
  class: "reorder",
  header: opts.header,
});

/** A ReorderTable row whose label links through to the item's own page:
 * reorder arrows, then the linked label, then any extra cells. */
const ReorderLinkRow = ({
  action,
  children,
  count,
  href,
  index,
  label,
  reorder = true,
}: ReorderProps & {
  children?: Child;
  href: string;
  label: Child;
  reorder?: boolean;
}): JSX.Element => (
  <tr>
    {reorder && <ReorderCell action={action} count={count} index={index} />}
    <td>
      <a href={href}>{label}</a>
    </td>
    {children}
  </tr>
);

export const reorderLinkTableAt = <T extends { id: number }>(
  path: string,
  orderLabel: string,
  columns: Child,
  items: T[],
  label: (item: T) => Child,
  children: (item: T) => Child,
  reorder = true,
): JSX.Element => (
  <ReorderTable columns={columns} orderLabel={orderLabel} reorder={reorder}>
    {items.map((item, index) => (
      <ReorderLinkRow
        action={(direction) => `${path}/${item.id}/move-${direction}`}
        count={items.length}
        href={`${path}/${item.id}`}
        index={index}
        label={label(item)}
        reorder={reorder}
      >
        {children(item)}
      </ReorderLinkRow>
    ))}
  </ReorderTable>
);

export const ReorderTable = ({
  columns,
  children,
  orderLabel,
  reorder = true,
}: {
  columns: Child;
  children: Child;
  orderLabel: string;
  reorder?: boolean;
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          {reorder && <th class={colClass("reorder")}>{orderLabel}</th>}
          {columns}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);
