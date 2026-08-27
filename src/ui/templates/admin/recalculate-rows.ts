import type { RecalculateRow } from "#templates/admin/recalculate.tsx";

/** One aggregate value in a recalculate snapshot: the stored `current` count,
 * and the `recalculated` count worked out fresh from the attendee records. */
type SnapshotValue = { current: number; recalculated: number };

/** Build a "stored vs recounted" row builder for one aggregate family, given
 * the fields it can repair. Every recalculate page — listing, modifier,
 * answer — is this one fold over its own field list. */
export const recalculateRowsFor =
  <Name extends string>(
    getFields: () => readonly { name: string; label: string }[],
  ) =>
  (snapshot: Record<Name, SnapshotValue>): RecalculateRow[] =>
    getFields().map((field) => {
      const name = field.name as Name;
      // The field list and the snapshot are paired module constants, so every
      // field must have a snapshot value. If one is missing the pairing is
      // wrong — fail loudly with the field name rather than crashing on
      // `.current`.
      const value = snapshot[name];
      if (!value) {
        throw new Error(
          `Recalculate snapshot is missing the "${field.name}" field`,
        );
      }
      return {
        current: String(value.current),
        label: field.label,
        name,
        recalculated: String(value.recalculated),
      };
    });
