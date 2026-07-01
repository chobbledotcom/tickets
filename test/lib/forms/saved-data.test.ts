import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  clearSavedFormData,
  entityToFieldValues,
  type Field,
  getSavedFormData,
  renderFields,
  runWithSavedFormContext,
  setSavedFormData,
} from "#shared/forms.tsx";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides });

describe("entityToFieldValues", () => {
  const fields = [
    field({ label: "A", name: "a" }),
    field({ label: "B", name: "b" }),
  ];

  test("derives field values from the entity", () => {
    const values = entityToFieldValues({ a: "1", b: "2" }, fields, {});
    expect(values).toEqual({ a: "1", b: "2" });
  });

  test("applies a formatter when one is supplied for the field", () => {
    const values = entityToFieldValues({ a: "1", b: "2" }, fields, {
      a: (e) => `formatted-${e.a}`,
    });
    expect(values.a).toBe("formatted-1");
    expect(values.b).toBe("2");
  });

  test("yields empty strings when there is no entity", () => {
    const values = entityToFieldValues(undefined, fields, {});
    expect(values).toEqual({ a: "", b: "" });
  });

  test("merges extra values over the entity-derived fields", () => {
    const values = entityToFieldValues(
      { a: "1", b: "2" },
      fields,
      {},
      {
        b: "override",
        c: "extra",
      },
    );
    expect(values.a).toBe("1");
    expect(values.b).toBe("override");
    expect(values.c).toBe("extra");
  });
});

describe("saved form data", () => {
  afterEach(() => clearSavedFormData());

  test("restores text values across all non-sensitive field types", () => {
    setSavedFormData(new FormParams("name=Alice&email=alice%40test.com"));
    const html = renderFields([
      field({ label: "Name", name: "name" }),
      field({ label: "Email", name: "email", type: "email" }),
    ]);
    expect(html).toContain('value="Alice"');
    expect(html).toContain('value="alice@test.com"');
  });

  test("does not restore password or file fields", () => {
    setSavedFormData(new FormParams("password=secret123&photo=hack.jpg"));
    const html = renderFields([
      field({ label: "Password", name: "password", type: "password" }),
      field({ label: "Photo", name: "photo", type: "file" }),
    ]);
    expect(html).not.toContain("secret123");
    expect(html).not.toContain("hack.jpg");
  });

  test("restores textarea, select, and checkbox-group values", () => {
    setSavedFormData(new FormParams("notes=My+notes&color=blue&tags=a&tags=c"));

    const notesHtml = renderFields([
      field({ label: "Notes", name: "notes", type: "textarea" }),
    ]);
    expect(notesHtml).toContain("My notes");

    const selectHtml = renderFields([
      field({
        label: "Color",
        name: "color",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
        type: "select",
      }),
    ]);
    expect(selectHtml).toContain('value="blue" selected');

    const checkboxHtml = renderFields([
      field({
        label: "Tags",
        name: "tags",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
          { label: "C", value: "c" },
        ],
        type: "checkbox-group",
      }),
    ]);
    expect(checkboxHtml).toContain('value="a" checked');
    expect(checkboxHtml).not.toContain('value="b" checked');
    expect(checkboxHtml).toContain('value="c" checked');
  });

  test("restores datetime date and time separately", () => {
    setSavedFormData(
      new FormParams("start_date=2026-03-21&start_time=14%3A30"),
    );
    const html = renderFields([
      field({ label: "Start", name: "start", type: "datetime" }),
    ]);
    expect(html).toContain('value="2026-03-21"');
    expect(html).toContain('value="14:30"');
  });

  test("defaults datetime time to 00:00 when only date was saved", () => {
    setSavedFormData(new FormParams("start_date=2026-03-21"));
    const html = renderFields([
      field({ label: "Start", name: "start", type: "datetime" }),
    ]);
    expect(html).toContain('value="2026-03-21"');
    expect(html).toContain('value="00:00"');
  });

  test("renders no value attributes for datetime when nothing was saved", () => {
    setSavedFormData(new FormParams("other=value"));
    const html = renderFields([
      field({ label: "Start", name: "start", type: "datetime" }),
    ]);
    expect(html).not.toContain('value="');
  });

  test("clearSavedFormData stops restoration", () => {
    setSavedFormData(new FormParams("name=Alice"));
    clearSavedFormData();
    expect(
      renderFields([field({ label: "Name", name: "name" })]),
    ).not.toContain("Alice");
  });

  test("renders no value attributes when nothing was saved", () => {
    expect(
      renderFields([field({ label: "Name", name: "name" })]),
    ).not.toContain('value="');
  });

  test("escapes HTML in saved values", () => {
    setSavedFormData(
      new FormParams("name=%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
    );
    const html = renderFields([field({ label: "Name", name: "name" })]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("empty explicit values defer to saved data", () => {
    // Admin create/edit pages pass entityToFieldValues, which yields "" for a
    // blank field. That empty value must not shadow a restored submission.
    setSavedFormData(new FormParams("name=Restored"));
    const html = renderFields([field({ label: "Name", name: "name" })], {
      name: "",
    });
    expect(html).toContain('value="Restored"');
  });

  test("empty explicit values stay empty when there is no saved data", () => {
    const html = renderFields(
      [field({ defaultValue: "Default", label: "Name", name: "name" })],
      { name: "" },
    );
    expect(html).not.toContain('value="Default"');
  });

  test("getSavedFormData returns the captured form", () => {
    const form = new FormParams("name=Alice");
    setSavedFormData(form);
    expect(getSavedFormData()).toBe(form);
  });

  test("getSavedFormData returns null once cleared", () => {
    setSavedFormData(new FormParams("name=Alice"));
    clearSavedFormData();
    expect(getSavedFormData()).toBeNull();
  });

  test("saved data set inside a scope stays within that scope", () => {
    const scopedForm = new FormParams("name=Scoped");
    const inside = runWithSavedFormContext(() => {
      setSavedFormData(scopedForm);
      return getSavedFormData();
    });
    expect(inside).toBe(scopedForm);
    expect(getSavedFormData()).toBeNull(); // ambient container untouched
  });

  test("concurrent request scopes do not leak saved form data", async () => {
    const request = (name: string) =>
      runWithSavedFormContext(async () => {
        const form = new FormParams(`name=${name}`);
        setSavedFormData(form);
        await new Promise((r) => setTimeout(r, 20));
        return getSavedFormData()?.getString("name");
      });
    const [a, b] = await Promise.all([request("Alice"), request("Bob")]);
    expect(a).toBe("Alice");
    expect(b).toBe("Bob");
  });
});
