import { t } from "#i18n";

export type ExpectedActualItem = {
  actual: string;
  expected: string;
  label: string;
};

export const hasExpectedActualMismatches = (
  items: ExpectedActualItem[],
): boolean => items.length > 0;

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
        <span class="badge-alert">{badge}</span> <strong>{first.label}</strong>:{" "}
        {t("expected_actual.expected")} <strong>{first.expected}</strong>,{" "}
        {t("expected_actual.got")} <strong>{first.actual}</strong>
        {extra}.
      </summary>
      <div>
        <p>{noticeTitle}</p>
        <p>{explanation}</p>
        <ul>
          {items.map((item) => (
            <li>
              <strong>{item.label}</strong>: {t("expected_actual.expected")}{" "}
              <strong>{item.expected}</strong>, {t("expected_actual.got")}{" "}
              <strong>{item.actual}</strong>
            </li>
          ))}
        </ul>
        {actionHref && actionLabel && (
          <p>
            <a href={actionHref}>{actionLabel}</a>
          </p>
        )}
      </div>
    </details>
  );
};
