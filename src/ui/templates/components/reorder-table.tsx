import type { Child } from "#jsx/jsx-runtime.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  ReorderArrows,
  type ReorderProps,
} from "#templates/components/reorder.tsx";
import { colClass } from "#templates/components/table-columns.ts";

export const writableReorderProps = (
  href: string,
): { href?: string; reorder: boolean } =>
  isReadOnly() ? { reorder: false } : { href, reorder: true };

export const ReorderCell = ({
  action,
  index,
  count,
}: ReorderProps): JSX.Element => (
  <td class={colClass("reorder")}>
    <ReorderArrows action={action} count={count} index={index} />
  </td>
);

/** A ReorderTable row whose label links through to the item's own page:
 * reorder arrows, then the linked label, then any extra cells. */
export const ReorderLinkRow = ({
  action,
  children,
  count,
  href,
  index,
  label,
  reorder = true,
}: ReorderProps & {
  children?: Child;
  href?: string | undefined;
  label: Child;
  reorder?: boolean;
}): JSX.Element => (
  <tr>
    {reorder && <ReorderCell action={action} count={count} index={index} />}
    <td>{href ? <a href={href}>{label}</a> : label}</td>
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
