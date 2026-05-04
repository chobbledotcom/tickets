import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  clearSavedFormData,
  type Field,
  renderFields,
  setSavedFormData,
} from "#shared/forms.tsx";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides });

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
});
