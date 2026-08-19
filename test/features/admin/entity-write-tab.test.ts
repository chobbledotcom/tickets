/**
 * The editing tabs an entity page is built from: a panel tab, a write-form
 * tab that hides in read-only mode, and the standard Actions tab whose only
 * entry is Delete. `defineEditEntityPage` folds those into the common
 * "one form, then delete" page.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { Raw } from "#jsx/jsx-runtime.ts";
import {
  defineEditEntityPage,
  panelTab,
  submittedValueProps,
  writeFormTab,
} from "#routes/admin/entity-write-tab.ts";
import type { AuthSession } from "#routes/auth.ts";
import { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import { getTestAuthSession } from "#test-utils/session.ts";

type Widget = { id: number; name: string };

const WIDGET: Widget = { id: 7, name: "Widget" };

const editPage = defineEditEntityPage<Widget>({
  deleteLabelKey: "common.delete",
  destination: "holiday",
  edit: (widget, _ctx, rejected) =>
    Promise.resolve(
      Raw({
        html: `<p>${widget.name}|${rejected?.form.get("name") ?? "clean"}</p>`,
      }),
    ),
  extraTabs: [
    panelTab<Widget>("notes", "entity.tab.activity", () =>
      Promise.resolve(Raw({ html: "<p>Notes</p>" })),
    ),
  ],
  load: (id) => Promise.resolve(id === 404 ? null : WIDGET),
  navActive: "/admin/holidays",
});

describe("submittedValueProps", () => {
  test("gives nothing back for a clean form", () => {
    expect(submittedValueProps()).toEqual({});
  });

  test("carries the error and the typed values of a rejected one", () => {
    const rejected = {
      error: "Name is taken",
      form: new FormParams({ name: "Typed" }),
    };

    expect(submittedValueProps(rejected)).toEqual({
      error: "Name is taken",
      values: { name: "Typed" },
    });
  });
});

describe("the tab kinds", () => {
  const load = () => Promise.resolve(Raw({ html: "<p>x</p>" }));

  test("marks a write-form tab as one, and a panel tab as neither", () => {
    // Read-only mode hides a tab by its intent, so only the writing one
    // carries it.
    expect(writeFormTab("edit", "entity.tab.edit", load).intent).toBe(
      "write-form",
    );
    expect(panelTab("notes", "entity.tab.activity", load).intent).toBe(
      undefined,
    );
  });

  test("keeps the slug and label it was given", () => {
    const tab = writeFormTab("edit", "entity.tab.edit", load);

    expect(tab.slug).toBe("edit");
    expect(tab.labelKey).toBe("entity.tab.edit");
    expect(tab.sections).toHaveLength(1);
  });

  test("takes a visibility rule only when one is given", () => {
    const gated = panelTab<Widget>(
      "notes",
      "entity.tab.activity",
      load,
      () => false,
    );

    expect(panelTab("notes", "entity.tab.activity", load).visible).toBe(
      undefined,
    );
    expect(gated.visible?.(WIDGET, {} as AuthSession)).toBe(false);
  });
});

describeWithEnv("an edit entity page", { db: true }, () => {
  test("opens on the edit tab, then the extras, then actions", async () => {
    setupTestEncryptionKey();
    const session = await getTestAuthSession();

    const html = await (await editPage.renderPage(session, 7, "")).text();

    expect(html).toContain("<p>Widget|clean</p>");
    expect(html).toContain('href="/admin/holidays/7/edit"');
    expect(html).toContain('href="/admin/holidays/7/notes"');
    expect(html).toContain('href="/admin/holidays/7/actions"');
  });

  test("offers deleting the record on the actions tab", async () => {
    const session = await getTestAuthSession();

    const html = await (
      await editPage.renderPage(session, 7, "actions")
    ).text();

    expect(html).toContain('href="/admin/holidays/7/delete"');
  });

  test("re-renders the edit tab at 400 with what was typed", async () => {
    const session = await getTestAuthSession();

    const response = await editPage.renderEditError(
      7,
      session,
      new FormParams({ name: "Half typed" }),
      "Name is taken",
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("<p>Widget|Half typed</p>");
  });

  test("hides the writing tabs in read-only mode", async () => {
    // Edit and Actions both write, so with writing switched off the page
    // opens on the reading tab that is left.
    const session = await getTestAuthSession();

    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const response = await editPage.renderPage(session, 7, "");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<p>Notes</p>");
    expect(html).not.toContain('href="/admin/holidays/7/actions"');
    expect(html).not.toContain("<p>Widget|clean</p>");
  });

  test("answers 404 for a record that is not there", async () => {
    const session = await getTestAuthSession();

    expect((await editPage.renderPage(session, 404, "")).status).toBe(404);
  });
});
