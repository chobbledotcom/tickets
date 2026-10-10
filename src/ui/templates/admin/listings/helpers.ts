import { formatDateLabel } from "#shared/date-labels.ts";

export const formatBookableDays = (days: string[]): string => days.join(", ");

export const attendeeCountLabelSuffix = (
  isDaily: boolean,
  dateFilter: string | null,
): string =>
  isDaily
    ? dateFilter
      ? ` (${formatDateLabel(dateFilter)})`
      : " (total)"
    : "";
