/**
 * One walk that collapses buyer-facing rows behind their package: rows booked
 * through a package that `collapses` gather into one group sitting where the
 * first of them was; every other row stands alone. Display labels stay with
 * the caller — only the grouping is shared.
 */

/** One row group: a collapsed package's rows carry its group id; a row that
 * stands alone carries none. */
export type PackageRowGroup<Row> = {
  groupId?: number | undefined;
  rows: Row[];
};

/** Walk rows once, gathering every package the caller allows to collapse into
 * one group at its first row's position. The one place the row→package walk
 * lives, so every buyer-facing surface (emails, SVG tickets, the public pay
 * page) groups rows identically. */
export const groupPackageRows = <Row>(
  rows: readonly Row[],
  groupIdOf: (row: Row) => number,
  collapses: (groupId: number) => boolean,
): PackageRowGroup<Row>[] => {
  const groups: PackageRowGroup<Row>[] = [];
  const started = new Map<number, PackageRowGroup<Row>>();
  for (const row of rows) {
    const groupId = groupIdOf(row);
    if (!collapses(groupId)) {
      groups.push({ rows: [row] });
      continue;
    }
    const began = started.get(groupId);
    if (began) {
      began.rows.push(row);
      continue;
    }
    const group: PackageRowGroup<Row> = { groupId, rows: [row] };
    started.set(groupId, group);
    groups.push(group);
  }
  return groups;
};
