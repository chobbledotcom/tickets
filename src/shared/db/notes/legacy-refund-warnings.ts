/** Bounded recognition of unnamed refund warnings written by older builds. */

import { chunk, unique } from "#fp";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { inPlaceholders, type SqlStatement } from "#shared/db/client.ts";
import { readRows } from "#shared/db/read.ts";
import { legacyRefundWarnings } from "#shared/payment/placeholder-refund.ts";
import { requireValue } from "#shared/required-value.ts";

type LegacySystemNoteRow = {
  id: number;
  note: EnvKeyEncrypted;
};

/** One small decryption wave. The extra row says whether another page exists
 * without opening its ciphertext. */
const LEGACY_NOTE_PAGE_SIZE = 20;

const legacySystemNotePage = (
  attendeeId: number,
  afterId: number,
): Promise<LegacySystemNoteRow[]> =>
  readRows<LegacySystemNoteRow>({
    columns: "note.id, note.note",
    from: "system_notes AS note",
    limit: LEGACY_NOTE_PAGE_SIZE + 1,
    order: "note.id",
    where: [
      {
        args: [attendeeId],
        clause: "note.entity_type = 'attendee' AND note.entity_id = ?",
      },
      { args: [], clause: "note.type = 'system'" },
      { args: [], clause: "note.system_name IS NULL" },
      { args: [afterId], clause: "note.id > ?" },
    ],
  });

const exactLegacyWarnings = (
  attendeeId: number,
  references: readonly string[],
): Set<string> =>
  new Set(
    unique([...references]).flatMap((reference) => [
      ...legacyRefundWarnings(attendeeId, reference),
    ]),
  );

/** Find exact historical refund warnings in bounded pages, then prepare
 * attendee-scoped deletes for the caller's refund-confirmation transaction. */
export const legacyRefundWarningDeleteStatements = async (
  attendeeId: number,
  references: readonly string[],
): Promise<SqlStatement[]> => {
  if (references.length === 0) return [];
  const expected = exactLegacyWarnings(attendeeId, references);
  const matchingIds: number[] = [];
  let afterId = 0;
  let hasNext = true;
  while (hasNext) {
    const page = await legacySystemNotePage(attendeeId, afterId);
    const visible = page.slice(0, LEGACY_NOTE_PAGE_SIZE);
    if (visible.length === 0) break;
    const opened = await Promise.all(
      visible.map(async (row) => ({
        id: row.id,
        matches: expected.has(await decrypt(row.note)),
      })),
    );
    matchingIds.push(
      ...opened.filter(({ matches }) => matches).map(({ id }) => id),
    );
    hasNext = page.length > LEGACY_NOTE_PAGE_SIZE;
    afterId = requireValue(
      visible.at(-1),
      "A non-empty legacy warning page needs a last row",
    ).id;
  }
  return chunk(LEGACY_NOTE_PAGE_SIZE)(matchingIds).map((ids) => ({
    args: [attendeeId, ...ids],
    sql: `DELETE FROM system_notes
           WHERE entity_type = 'attendee'
             AND entity_id = ?
             AND type = 'system'
             AND system_name IS NULL
             AND id IN (${inPlaceholders(ids)})`,
  }));
};
