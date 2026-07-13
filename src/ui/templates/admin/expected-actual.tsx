import { t } from "#i18n";
import { Badge } from "#templates/components/badge.tsx";
import { ItemList } from "#templates/components/item-list.tsx";

export type ExpectedActualItem = {
  actual: string;
  expected: string;
  label: string;
};

/** Keeps only the rows whose stored value no longer matches the recount,
 * turned into the items the drift notice displays. Shared by the listing and
 * answer running-total warnings, which build the same recalculate rows. */
export const driftedRowItems = (
  rows: readonly { current: string; label: string; recalculated: string }[],
): ExpectedActualItem[] =>
  rows.flatMap((row) =>
    row.current === row.recalculated
      ? []
      : [{ actual: row.current, expected: row.recalculated, label: row.label }],
  );

/** One drift line: the label, the value we expected, and the value stored. */
const MismatchText = ({ item }: { item: ExpectedActualItem }): JSX.Element => (
  <>
    <strong>{item.label}</strong>: {t("expected_actual.expected")}{" "}
    <strong>{item.expected}</strong>, {t("expected_actual.got")}{" "}
    <strong>{item.actual}</strong>
  </>
);

export const ExpectedActualNotice = ({
  actionHref,
  actionLabel,
  badgeLabel,
  explanation,
  items,
  title,
}: {
  actionHref?: string;
  actionLabel?: string;
  badgeLabel?: string;
  explanation: string;
  items: ExpectedActualItem[];
  title?: string;
}): JSX.Element | null => {
  const first = items[0];
  if (!first) return null;
  const badge = badgeLabel ?? t("expected_actual.badge_error");
  const extra =
    items.length > 1
      ? ` ${t("expected_actual.more", { count: items.length - 1 })}`
      : "";
  const noticeTitle = title ?? t("expected_actual.default_title");
  return (
    <details class="expected-actual-notice" role="alert">
      <summary>
        <Badge variant="alert">{badge}</Badge> <MismatchText item={first} />
        {extra}.
      </summary>
      <div>
        <p>{noticeTitle}</p>
        <p>{explanation}</p>
        <ItemList
          items={items}
          render={(item) => <MismatchText item={item} />}
        />
        {actionHref && actionLabel && (
          <p>
            <a href={actionHref}>{actionLabel}</a>
          </p>
        )}
      </div>
    </details>
  );
};

export const ExpectedActualTableRow = ({
  header,
  notice,
}: {
  header: string;
  notice: Parameters<typeof ExpectedActualNotice>[0];
}): JSX.Element | null => {
  if (notice.items.length === 0) return null;
  return (
    <tr>
      <th>{header}</th>
      <td>
        <ExpectedActualNotice {...notice} />
      </td>
    </tr>
  );
};
