import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
  runRecalculatePost,
  selectedRecalculationFields,
} from "#routes/admin/aggregate-recalculation.ts";
import { parseFlashValue } from "#shared/cookies.ts";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { runWithRequestId } from "#shared/logger.ts";

const FIELDS = ["income", "tickets"] as const;

describe("selectedRecalculationFields", () => {
  test("returns selected fields in their declared order", () => {
    expect(
      selectedRecalculationFields(
        new FormParams("recalculate_fields=tickets&recalculate_fields=income"),
        FIELDS,
      ),
    ).toEqual(["income", "tickets"]);
  });

  test("returns no fields when none were submitted", () => {
    expect(selectedRecalculationFields(new FormParams(), FIELDS)).toEqual([]);
  });

  test("rejects the first unknown field", () => {
    expect(() =>
      selectedRecalculationFields(
        new FormParams("recalculate_fields=income&recalculate_fields=bogus"),
        FIELDS,
      ),
    ).toThrow("Invalid recalculation field: bogus");
  });
});

const editableFields: Field[] = [{ label: "Name", name: "name", type: "text" }];

describe("parseEditableAggregateForm", () => {
  test("skips an aggregate whose fields were not submitted", () => {
    expect(
      parseEditableAggregateForm(
        new FormParams({ other: "value" }),
        editableFields,
        (values) => values,
      ),
    ).toEqual({ input: null, ok: true });
  });

  test("parses an aggregate when one of its fields was submitted", () => {
    expect(
      parseEditableAggregateForm<{ name: string }, string>(
        new FormParams({ name: "New name" }),
        editableFields,
        (values) => values.name,
      ),
    ).toEqual({ input: "New name", ok: true });
  });
});

describe("runRecalculatePost", () => {
  test("renders the choice error without changing aggregates", async () => {
    let resetCount = 0;
    let logCount = 0;
    const response = await runRecalculatePost({
      fields: FIELDS,
      form: new FormParams(),
      log: () => {
        logCount += 1;
        return Promise.resolve();
      },
      renderChoose: () => new Response("Choose a field", { status: 400 }),
      reset: () => {
        resetCount += 1;
        return Promise.resolve();
      },
      successMessage: "Recalculated.",
      successPath: "/admin/listings/1/edit",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Choose a field");
    expect(resetCount).toBe(0);
    expect(logCount).toBe(0);
  });

  test("resets selected aggregates, logs, and redirects", async () => {
    const calls: string[] = [];
    const response = await runWithRequestId(() =>
      runRecalculatePost({
        fields: FIELDS,
        form: new FormParams("recalculate_fields=tickets"),
        log: () => {
          calls.push("log");
          return Promise.resolve();
        },
        renderChoose: () => new Response("wrong branch", { status: 400 }),
        reset: (selected) => {
          calls.push(`reset:${selected.join(",")}`);
          return Promise.resolve();
        },
        successMessage: "Recalculated.",
        successPath: "/admin/listings/1/edit",
      }),
    );

    expect(calls).toEqual(["reset:tickets", "log"]);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^\/admin\/listings\/1\/edit\?flash=[a-f0-9]+$/,
    );
    const cookieValue = response.headers
      .get("set-cookie")
      ?.split("=")[1]
      ?.split(";")[0];
    if (cookieValue === undefined) throw new Error("Missing flash cookie");
    expect(parseFlashValue(cookieValue)).toEqual({
      error: undefined,
      formToken: undefined,
      info: undefined,
      result: undefined,
      success: "Recalculated.",
    });
  });
});

describe("createRecalculatePageRenderer", () => {
  test("renders the snapshot and success response", async () => {
    const render = createRecalculatePageRenderer(
      (entity: { id: number }) => Promise.resolve(`snapshot-${entity.id}`),
      (entity, snapshot, session: string, error, success) =>
        [entity.id, snapshot, session, error, success].join("|"),
    );
    const response = await render({ id: 3 }, "owner", undefined, "Saved.");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("3|snapshot-3|owner||Saved.");
  });

  test("uses status 400 when rendering an error", async () => {
    const render = createRecalculatePageRenderer(
      () => Promise.resolve("snapshot"),
      (_entity: string, _snapshot, _session: string, error) => error ?? "",
    );
    const response = await render("entity", "owner", "Choose a field");

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Choose a field");
  });
});
