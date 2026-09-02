/**
 * Demo-mode form overrides: which fields a demo install fills with sample
 * values, and the wrappers that run them. This mirror is what the mutation
 * gate runs against overrides.ts.
 */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { holidays } from "#db/holidays.ts";
import { validateDateRange } from "#routes/admin/holidays.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  applyDemoOverrides,
  loadAfterDemoOverrides,
  wrapResourceForDemo,
} from "#shared/demo/overrides.ts";
import { FormParams } from "#shared/form-data.ts";
import { defineResource } from "#shared/rest/resource.ts";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("demo overrides", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  const formWith = (fields: Record<string, string>): FormParams =>
    new FormParams(fields);

  test("leaves the form alone while demo mode is off", () => {
    const form = formWith({ name: "Real Person" });

    const result = applyDemoOverrides(form, {
      name: ["Demo Person"],
    });

    expect(result).toBe(form);
    expect(result.get("name")).toBe("Real Person");
  });

  test("replaces a filled field with one of the sample values", () => {
    setDemoModeForTest(true);
    const form = formWith({ name: "Real Person", untouched: "kept" });

    const result = applyDemoOverrides(form, {
      name: ["Demo Person", "Another Person"],
    });

    expect(result).toBe(form);
    expect(["Demo Person", "Another Person"]).toContain(result.get("name"));
    expect(result.get("untouched")).toBe("kept");
  });

  test("keeps an empty field empty, and never adds an absent one", () => {
    setDemoModeForTest(true);
    const form = formWith({ name: "" });

    const result = applyDemoOverrides(form, {
      absent: ["Never Set"],
      name: ["Demo Person"],
    });

    expect(result.get("name")).toBe("");
    expect(result.has("absent")).toBe(false);
  });

  test("applies the overrides before the loader runs", async () => {
    setDemoModeForTest(true);
    const form = formWith({ name: "Real Person" });

    const seen: string[] = [];
    const loaded = await loadAfterDemoOverrides(
      form,
      { name: ["Demo"] },
      () => {
        seen.push(form.get("name") ?? "");
        return Promise.resolve(3);
      },
    );

    expect(loaded).toBe(3);
    expect(seen).toEqual(["Demo"]);
  });

  test("hands the loader's empty answer through", async () => {
    setDemoModeForTest(true);

    const loaded = await loadAfterDemoOverrides(formWith({}), {}, () =>
      Promise.resolve(null),
    );

    expect(loaded).toBeNull();
  });

  test("wraps a resource so create and update see the samples", async () => {
    setDemoModeForTest(true);
    const wrapped = wrapResourceForDemo(
      defineResource({
        form: getHolidayForm(),
        table: holidays.table,
        toInput: (values) => ({
          endDate: values.end_date,
          name: values.name,
          startDate: values.start_date,
        }),
        validate: validateDateRange,
      }),
      { name: ["Demo Holiday"] },
    );

    const created = await wrapped.create(
      formWith({
        end_date: "2027-01-02",
        name: "Real",
        start_date: "2027-01-01",
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.row.name).toBe("Demo Holiday");

    const updated = await wrapped.update(
      created.row.id,
      formWith({
        end_date: "2027-01-02",
        name: "Real",
        start_date: "2027-01-01",
      }),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.row.id).toBe(created.row.id);
    expect(updated.row.name).toBe("Demo Holiday");

    const loaded = await wrapped.loadOrNull(created.row.id);
    expect(loaded?.name).toBe("Demo Holiday");
  });
});
