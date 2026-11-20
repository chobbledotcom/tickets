import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { requireValue } from "#shared/required-value.ts";
import { describeWithEnv } from "#test-utils/db.ts";

type RecordWords = { activityName: string; nameLabel?: string };

/** The words a record's delete page shows above the name it asks for. */
export const deleteConfirmLabel = (record: { nameLabel?: string }): string =>
  t(
    requireValue(
      record.nameLabel,
      "The record declares no delete confirmation label",
    ),
  );

/** What a record calls itself on its pages, and the label its delete page
 *  asks for, or null when it has no delete page label. */
const wordsOf = (record: RecordWords) => ({
  activityName: record.activityName,
  deleteLabel:
    record.nameLabel === undefined ? null : deleteConfirmLabel(record),
});

/** Declare the test that pins the words one record shows (its activity name
 *  and its delete page label, or null), and the record's commands, run
 *  against the test database. */
export const describeRecord = (
  record: RecordWords,
  activityName: string,
  deleteLabel: string | null,
  commands: () => void,
): void => {
  const words = { activityName, deleteLabel };
  describe(`the ${words.activityName} record's words`, () => {
    test("names the record on its pages and its delete page", () => {
      expect(wordsOf(record)).toEqual(words);
    });
  });
  describeWithEnv(
    `the ${words.activityName} record's commands`,
    { db: true },
    commands,
  );
};
