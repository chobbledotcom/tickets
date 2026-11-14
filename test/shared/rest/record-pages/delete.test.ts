/**
 * The record delete pages: the confirmation label, the delete outcomes, and
 * the landing and flash a page can override.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { CrudHandlers } from "#routes/admin/route-tables.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions/redirect.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  deleteAs,
  pagesFor,
  pagesForRecord,
  testLandings,
} from "#test-utils/record-pages.ts";

const mismatch = (label: string): string =>
  t("common.confirm_mismatch", {
    lower: label.toLowerCase(),
    suffix: " deletion",
    thing: label,
  });

const inUse = {
  remove: () =>
    Promise.resolve({ kind: "refused" as const, message: "In use" }),
};

const wrongName = (pages: CrudHandlers) => deleteAs(pages, "Wrong");

describeWithEnv("the record delete pages", { db: true }, () => {
  testLandings(
    { act: deleteAs, succeeded: true },
    {
      "a delete lands where the page says, with the flash it names": [
        { deleteSuccessMessage: "Gone", deleteSuccessPath: "/admin" },
        "/admin",
        "Gone",
      ],
      "an empty delete flash and landing are kept, not defaulted": [
        { deleteSuccessMessage: "", deleteSuccessPath: "" },
        "/",
        "",
      ],
    },
  );

  testLandings(
    { act: (pages) => deleteAs(pages, "Widget!"), succeeded: true },
    {
      "the confirmation matches the identifier the page declares": [
        { identifier: (row) => `${row.name}!` },
        "/admin/holidays",
        "Widget deleted",
      ],
    },
  );

  testLandings(
    { act: deleteAs, succeeded: false, write: inUse },
    {
      "a refused delete returns to its confirmation page": [
        {},
        "/admin/holidays/7/delete",
        "In use",
      ],
      "a refused delete returns to the delete route the page names": [
        { routes: { delete: "groupDelete" } },
        "/admin/groups/7/delete",
        "In use",
      ],
    },
  );

  testLandings(
    { act: wrongName, succeeded: false },
    {
      "a mismatched name with no label asks for an unnamed value": [
        {},
        "/admin/holidays/7/delete",
        mismatch(""),
      ],
    },
  );

  test("a confirmed delete lands on the list with a success flash", async () => {
    const removed: [number, unknown][] = [];
    const pages = pagesFor(
      { deleteInput: (data) => data.getString("confirm_identifier") },
      {
        remove: (id, input) => {
          removed.push([id, input]);
          return Promise.resolve({ kind: "deleted" });
        },
      },
    );

    expectRedirectWithFlash(
      "/admin/holidays",
      "Widget deleted",
    )(await deleteAs(pages));
    expect(removed).toEqual([[7, "Widget"]]);
  });

  test("a delete with no input reader hands the command no input", async () => {
    const removed: unknown[] = [];
    const pages = pagesFor(
      {},
      {
        remove: (_id, input) => {
          removed.push(input);
          return Promise.resolve({ kind: "deleted" });
        },
      },
    );

    await deleteAs(pages);

    expect(removed).toEqual([undefined]);
  });

  test("a delete of a vanished row answers 404", async () => {
    const pages = pagesFor(
      {},
      { remove: () => Promise.resolve({ kind: "not-found" }) },
    );

    expect((await deleteAs(pages)).status).toBe(404);
  });

  test("a mismatched name uses the label the record declares", async () => {
    const pages = pagesForRecord({ nameLabel: "news.name_label" });

    expectRedirectWithFlash(
      "/admin/holidays/7/delete",
      mismatch(t("news.name_label")),
      false,
    )(await wrongName(pages));
  });

  test("a delete guard refuses the delete before it runs", async () => {
    const guarded: number[] = [];
    const pages = pagesFor({
      deleteGuard: (_row, id) => {
        guarded.push(id);
        return Promise.resolve("Still booked");
      },
    });

    expectRedirectWithFlash(
      "/admin/holidays/7/delete",
      "Still booked",
      false,
    )(await deleteAs(pages));
    expect(guarded).toEqual([7]);
  });
});
