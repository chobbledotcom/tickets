import type { Child } from "#jsx/jsx-runtime.ts";
import {
  ReorderArrows,
  type ReorderProps,
} from "#templates/components/reorder.tsx";
import { colClass } from "#templates/components/table-columns.ts";

export const ReorderCell = ({
  action,
  index,
  count,
}: ReorderProps): JSX.Element => (
  <td class={colClass("reorder")}>
    <ReorderArrows action={action} count={count} index={index} />
  </td>
);

const ReorderLinkRow = ({
  action,
  children,
  count,
  href,
  index,
  label,
}: ReorderProps & {
  children?: Child;
  href: string;
  label: Child;
}): JSX.Element => (
  <tr>
    <ReorderCell action={action} count={count} index={index} />
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
): JSX.Element => (
  <ReorderTable columns={columns} orderLabel={orderLabel}>
    {items.map((item, index) => (
      <ReorderLinkRow
        action={(direction) => `${path}/${item.id}/move-${direction}`}
        count={items.length}
        href={`${path}/${item.id}`}
        index={index}
        label={label(item)}
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
}: {
  columns: Child;
  children: Child;
  orderLabel: string;
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th class={colClass("reorder")}>{orderLabel}</th>
          {columns}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);
