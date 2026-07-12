import type { RecalculateRow } from "#templates/admin/recalculate.tsx";

/** One aggregate value in a recalculate snapshot: the stored `current` count,
 * and the `recalculated` count worked out fresh from the attendee records. */
type SnapshotValue = { current: number; recalculated: number };

/** Build the "stored vs recounted" rows for a recalculate page. For each
 * aggregate field it formats the stored value and the recounted value the same
 * way, so the listing and modifier recalculate pages build their rows once. */
export const buildRecalculateRows = <Name extends string>(
  fields: readonly { name: string; label: string }[],
  formatValue: (name: Name, value: number) => string,
  snapshot: Record<Name, SnapshotValue>,
): RecalculateRow[] =>
  fields.map((field) => {
    const name = field.name as Name;
    // The field list and the snapshot are paired module constants, so every
    // field must have a snapshot value. If one is missing the pairing is wrong
    // — fail loudly with the field name rather than crashing on `.current`.
    const value = snapshot[name];
    if (!value) {
      throw new Error(
        `Recalculate snapshot is missing the "${field.name}" field`,
      );
    }
    return {
      current: formatValue(name, value.current),
      label: field.label,
      name,
      recalculated: formatValue(name, value.recalculated),
    };
  });
