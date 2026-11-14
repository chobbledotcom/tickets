/**
 * The command-record write steps: the rule runs first, a domain error answers
 * a refusal or not-found, and a written row is logged.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { TxScope } from "#db/client.ts";
import type { RecordRule, WriteVerdict } from "#shared/rest/record.ts";
import {
  commitCommand,
  contentCommands,
  deleteAndLog,
  deleteCommand,
  deleteIfPresent,
  ruledCommand,
  ruleFromValidator,
  transactCommand,
  updateIfPresent,
  writeAndLog,
} from "#shared/rest/record-command.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import type { IdNameInput, IdNameRow } from "#test-utils/rest-fixtures.ts";

const passRule = (input: IdNameInput) => okResult(input);
const refuseRule = () => errorResult("Rule says no");

type MarkingRule = RecordRule<IdNameInput, IdNameRow>;

/** Run one command with a rule that marks the input name. Expect the command
 *  to write the marked name, and the rule to see the stored row. */
const expectRuledWrite = async (
  id: number,
  command: (
    rule: MarkingRule,
    stored: IdNameRow,
  ) => Promise<WriteVerdict<IdNameRow>>,
): Promise<void> => {
  const seen: (IdNameRow | null)[] = [];
  const stored = { id, name: "Stored" };
  const rule: MarkingRule = (input, row) => {
    seen.push(row);
    return okResult({ name: `${input.name}!` });
  };

  expect(await command(rule, stored)).toEqual({
    kind: "written",
    row: { id, name: "raw!" },
  });
  expect(seen).toEqual([stored]);
};

/** A command whose write answers its own not-found error. */
const GONE_COMMAND = {
  input: { name: "raw" },
  log: () => Promise.resolve(),
  message: () => "refused",
  notFound: "gone" as const,
  rule: passRule,
  write: () => Promise.resolve(errorResult("gone" as const)),
};

describe("the command write answers", () => {
  test("answers the written row and logs it", async () => {
    const logged: number[] = [];
    const verdict = await writeAndLog({
      log: (row: { id: number }) => {
        logged.push(row.id);
        return Promise.resolve();
      },
      message: () => "refused",
      write: () => Promise.resolve(okResult({ id: 4 })),
    });
    expect(verdict).toEqual({ kind: "written", row: { id: 4 } });
    expect(logged).toEqual([4]);
  });

  test("answers the not-found error as not found", async () => {
    const verdict = await writeAndLog({
      log: () => Promise.resolve(),
      message: () => "refused",
      notFound: "notFound",
      write: () => Promise.resolve(errorResult("notFound")),
    });
    expect(verdict).toEqual({ kind: "not-found" });
  });

  test("answers another domain error with its message and logs nothing", async () => {
    const logged: unknown[] = [];
    const verdict = await writeAndLog({
      log: (row) => {
        logged.push(row);
        return Promise.resolve();
      },
      message: (error) => `That name is taken (${error})`,
      notFound: "notFound",
      write: () => Promise.resolve(errorResult("slugTaken")),
    });
    expect(verdict).toEqual({
      kind: "refused",
      message: "That name is taken (slugTaken)",
    });
    expect(logged).toEqual([]);
  });
});

describe("the record rule steps", () => {
  test("a validator rule passes the input and hands the stored id", async () => {
    const seen: (number | undefined)[] = [];
    const rule = ruleFromValidator<IdNameInput, IdNameRow>((_input, id) => {
      seen.push(id);
      return Promise.resolve(null);
    });

    expect(await rule({ name: "A" }, { id: 5, name: "Stored" })).toEqual(
      okResult({ name: "A" }),
    );
    expect(await rule({ name: "B" }, null)).toEqual(okResult({ name: "B" }));
    expect(seen).toEqual([5, undefined]);
  });

  test("a validator rule refuses with the validator's message", async () => {
    const rule = ruleFromValidator<IdNameInput, IdNameRow>(() =>
      Promise.resolve("Bad name"),
    );

    expect(await rule({ name: "A" }, null)).toEqual(errorResult("Bad name"));
  });

  test("a ruled command runs on the ruled value and hands the rule the stored row", async () => {
    await expectRuledWrite(1, (rule, stored) =>
      ruledCommand<IdNameRow, IdNameInput>({
        input: { name: "raw" },
        rule,
        run: (value) =>
          Promise.resolve({
            kind: "written",
            row: { id: 1, name: value.name },
          }),
        stored,
      }),
    );
  });

  test("a ruled command answers the rule's refusal without running", async () => {
    const verdict = await ruledCommand<IdNameRow, IdNameInput>({
      input: { name: "raw" },
      rule: refuseRule,
      run: () => Promise.reject(new Error("must not run")),
      stored: null,
    });

    expect(verdict).toEqual({ kind: "refused", message: "Rule says no" });
  });

  test("a committed command writes the ruled value and logs the row", async () => {
    const logged: IdNameRow[] = [];
    await expectRuledWrite(2, (rule, stored) =>
      commitCommand<IdNameRow, IdNameInput>({
        input: { name: "raw" },
        log: (row) => {
          logged.push(row);
          return Promise.resolve();
        },
        message: () => "refused",
        rule,
        stored,
        write: (value) =>
          Promise.resolve(okResult({ id: 2, name: value.name })),
      }),
    );

    expect(logged).toEqual([{ id: 2, name: "raw!" }]);
  });

  test("a committed command answers its not-found error as not found", async () => {
    const verdict = await commitCommand<IdNameRow, IdNameInput, "gone">({
      ...GONE_COMMAND,
      stored: null,
    });

    expect(verdict).toEqual({ kind: "not-found" });
  });
});

describe("the load and delete steps", () => {
  const load = (id: number) =>
    Promise.resolve(id === 1 ? { id: 1, name: "Stored" } : null);

  test("an update of a present row saves it with the input", async () => {
    const verdict = await updateIfPresent<IdNameRow, IdNameInput>(
      load,
      (row, input) =>
        Promise.resolve({ kind: "written", row: { ...row, ...input } }),
      1,
      { name: "New" },
    );

    expect(verdict).toEqual({ kind: "written", row: { id: 1, name: "New" } });
  });

  test("an update of an absent row answers not found", async () => {
    const verdict = await updateIfPresent<IdNameRow, IdNameInput>(
      load,
      () => Promise.reject(new Error("must not save")),
      2,
      { name: "New" },
    );

    expect(verdict).toEqual({ kind: "not-found" });
  });

  test("deletes a present row and skips an absent log", async () => {
    const removed: number[] = [];
    const verdict = await deleteIfPresent(7, {
      destroy: (row: { id: number }) => {
        removed.push(row.id);
        return Promise.resolve();
      },
      load: () => Promise.resolve({ id: 7 }),
    });
    expect(verdict).toEqual({ kind: "deleted" });
    expect(removed).toEqual([7]);
  });

  test("answers not found for an absent row", async () => {
    const verdict = await deleteIfPresent(7, {
      destroy: () => Promise.reject(new Error("must not run")),
      load: () => Promise.resolve(null),
    });
    expect(verdict).toEqual({ kind: "not-found" });
  });

  test("a delete command destroys the row, then logs it", async () => {
    const steps: string[] = [];
    const remove = deleteCommand<IdNameRow>(
      load,
      (row) => {
        steps.push(`destroy ${row.name}`);
        return Promise.resolve();
      },
      (row) => {
        steps.push(`log ${row.name}`);
        return Promise.resolve();
      },
    );

    expect(await remove(1)).toEqual({ kind: "deleted" });
    expect(await remove(2)).toEqual({ kind: "not-found" });
    expect(steps).toEqual(["destroy Stored", "log Stored"]);
  });

  test("a logged delete of an absent row logs nothing", async () => {
    const verdict = await deleteAndLog(3, {
      destroy: () => Promise.reject(new Error("must not run")),
      load,
      log: () => Promise.reject(new Error("must not log")),
    });

    expect(verdict).toEqual({ kind: "not-found" });
  });
});

describeWithEnv("the transacted command writes", { db: true }, () => {
  test("a transacted command writes and logs inside one transaction", async () => {
    const txs: TxScope[] = [];
    const verdict = await transactCommand<IdNameRow, IdNameInput>({
      input: { name: "raw" },
      log: (_row, tx) => {
        txs.push(tx);
        return Promise.resolve();
      },
      message: () => "refused",
      rule: (input, stored) =>
        okResult({ name: stored === null ? `${input.name}!` : "stored" }),
      write: (tx, value) => {
        txs.push(tx);
        return Promise.resolve(okResult({ id: 3, name: value.name }));
      },
    });

    expect(verdict).toEqual({ kind: "written", row: { id: 3, name: "raw!" } });
    expect(txs).toHaveLength(2);
    expect(txs[0]).toBe(txs[1]);
  });

  test("a transacted command answers its not-found error as not found", async () => {
    const verdict = await transactCommand<IdNameRow, IdNameInput, "gone">(
      GONE_COMMAND,
    );

    expect(verdict).toEqual({ kind: "not-found" });
  });

  const contentLog: string[] = [];
  const updates: [number, IdNameInput][] = [];
  const content = (notFound?: "missing") =>
    contentCommands<IdNameRow, IdNameInput, "missing" | "taken">({
      create: (input) =>
        Promise.resolve(
          input.name === "Taken"
            ? errorResult("taken")
            : okResult({ id: 2, name: input.name }),
        ),
      load: (id) =>
        Promise.resolve(id === 1 ? { id: 1, name: "Stored" } : null),
      log: (name, verb) => {
        contentLog.push(`${name} ${verb}`);
        return Promise.resolve();
      },
      message: () => "That slug is taken",
      ...(notFound === undefined ? {} : { notFound }),
      remove: () => Promise.resolve(),
      rule: (input) =>
        input.name === "" ? errorResult("Needs a name") : okResult(input),
      update: (id, input) => {
        updates.push([id, input]);
        return Promise.resolve(
          input.name === "Gone/slug"
            ? errorResult("missing")
            : okResult({ id, name: input.name }),
        );
      },
      updateInput: (input) => ({ name: `${input.name}/slug` }),
    });

  test("content commands create, update, and delete with their log verbs", async () => {
    contentLog.length = 0;
    updates.length = 0;
    const commands = content();

    expect(await commands.create({ name: "New" })).toEqual({
      kind: "written",
      row: { id: 2, name: "New" },
    });
    expect(await commands.update(1, { name: "Renamed" })).toEqual({
      kind: "written",
      row: { id: 1, name: "Renamed/slug" },
    });
    expect(await commands.remove(1)).toEqual({ kind: "deleted" });
    expect(contentLog).toEqual([
      "New created",
      "Renamed/slug updated",
      "Stored deleted",
    ]);
    expect(updates).toEqual([[1, { name: "Renamed/slug" }]]);
  });

  test("content commands answer the rule, the slug error, and a missing row", async () => {
    contentLog.length = 0;
    const commands = content("missing");

    expect(await commands.create({ name: "" })).toEqual({
      kind: "refused",
      message: "Needs a name",
    });
    expect(await commands.create({ name: "Taken" })).toEqual({
      kind: "refused",
      message: "That slug is taken",
    });
    expect(await commands.update(1, { name: "Gone" })).toEqual({
      kind: "not-found",
    });
    expect(await commands.update(9, { name: "Any" })).toEqual({
      kind: "not-found",
    });
    expect(await commands.remove(9)).toEqual({ kind: "not-found" });
    expect(contentLog).toEqual([]);
  });

  test("a content update needs no not-found error of its own", async () => {
    const verdict = await content().update(1, { name: "Gone" });

    expect(verdict).toEqual({ kind: "refused", message: "That slug is taken" });
  });
});
