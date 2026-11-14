/**
 * The record delete pages: the confirmation label, the delete outcomes, and
 * the landing and flash a page can override.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { recordPages } from "#shared/rest/record-pages.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions/redirect.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  deleteAs,
  form,
  pagesFor,
  recordWith,
  type Shape,
  toInput,
  type Values,
} from "#test-utils/record-pages.ts";

const mismatch = (label: string): string =>
  t("common.confirm_mismatch", {
    lower: label.toLowerCase(),
    suffix: " deletion",
    thing: label,
  });

describeWithEnv("the record delete pages", { db: true }, () => {
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

  test("a delete lands where the page says, with the flash it names", async () => {
    const pages = pagesFor({
      deleteSuccessMessage: "Gone",
      deleteSuccessPath: "/admin",
    });

    expectRedirectWithFlash("/admin", "Gone")(await deleteAs(pages));
  });

  test("a refused delete returns to its confirmation page", async () => {
    const pages = pagesFor(
      {},
      { remove: () => Promise.resolve({ kind: "refused", message: "In use" }) },
    );

    expectRedirectWithFlash(
      "/admin/holidays/7/delete",
      "In use",
      false,
    )(await deleteAs(pages));
  });

  test("a refused delete returns to the delete route the page names", async () => {
    const pages = pagesFor(
      { routes: { delete: "groupDelete" } },
      { remove: () => Promise.resolve({ kind: "refused", message: "In use" }) },
    );

    expectRedirectWithFlash(
      "/admin/groups/7/delete",
      "In use",
      false,
    )(await deleteAs(pages));
  });

  test("a delete of a vanished row answers 404", async () => {
    const pages = pagesFor(
      {},
      { remove: () => Promise.resolve({ kind: "not-found" }) },
    );

    expect((await deleteAs(pages)).status).toBe(404);
  });

  test("a mismatched name with no label asks for an unnamed value", async () => {
    expectRedirectWithFlash(
      "/admin/holidays/7/delete",
      mismatch(""),
      false,
    )(await deleteAs(pagesFor(), "Wrong"));
  });

  test("a mismatched name uses the label the record declares", async () => {
    const pages = recordPages<Shape, Values>(
      recordWith({}, { nameLabel: "news.name_label" }),
      { form: form("Widget"), toInput },
    );

    expectRedirectWithFlash(
      "/admin/holidays/7/delete",
      mismatch(t("news.name_label")),
      false,
    )(await deleteAs(pages, "Wrong"));
  });

  test("the confirmation matches the identifier the page declares", async () => {
    const pages = pagesFor({ identifier: (row) => `${row.name}!` });

    expectRedirectWithFlash(
      "/admin/holidays",
      "Widget deleted",
    )(await deleteAs(pages, "Widget!"));
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
