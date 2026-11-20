/**
 * The answers each admin record's commands give follow from its declaration.
 * The checks are types: a wrong answer type fails the typecheck.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Holiday } from "#db/holidays.ts";
import type {
  EmailTemplateRow,
  emailTemplateRecord,
} from "#shared/records/email-templates.ts";
import type { groupRecord } from "#shared/records/groups.ts";
import type { holidayRecord } from "#shared/records/holidays.ts";
import type { imageRecord } from "#shared/records/images.ts";
import type {
  Deleted,
  DeleteVerdict,
  Missing,
  WriteVerdict,
  Written,
} from "#shared/rest/record.ts";

/** True when the two types are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The answer one command gives. */
type AnswerOf<Command extends (...args: never[]) => unknown> = Awaited<
  ReturnType<Command>
>;

describe("the answers a record declares", () => {
  test("each command answers only what its declaration can give", () => {
    const answers: [
      Same<AnswerOf<typeof holidayRecord.remove>, Deleted | Missing>,
      Same<AnswerOf<typeof imageRecord.remove>, Deleted | Missing>,
      Same<AnswerOf<typeof groupRecord.remove>, DeleteVerdict>,
      Same<AnswerOf<typeof holidayRecord.create>, WriteVerdict<Holiday>>,
      Same<
        AnswerOf<typeof emailTemplateRecord.create>,
        Written<EmailTemplateRow> | Missing
      >,
    ] = [true, true, true, true, true];
    expect(answers).toEqual([true, true, true, true, true]);
  });
});
