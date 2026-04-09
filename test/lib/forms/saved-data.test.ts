import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  clearSavedFormData,
  type Field,
  renderFields,
  setSavedFormData,
} from "#lib/forms.tsx";
import { FormParams } from "#lib/form-data.ts";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides });

describe("saved form data", () => {
  afterEach(() => clearSavedFormData());

  test("restores text values across all non-sensitive field types", () => {
    setSavedFormData(new FormParams("name=Alice&email=alice%40test.com"));
    const html = renderFields([
      field({ name: "name", label: "Name" }),
      field({ name: "email", label: "Email", type: "email" }),
    ]);
    expect(html).toContain('value="Alice"');
    expect(html).toContain('value="alice@test.com"');
  });

  test("does not restore password or file fields", () => {
    setSavedFormData(new FormParams("password=secret123&photo=hack.jpg"));
    const html = renderFields([
      field({ name: "password", label: "Password", type: "password" }),
      field({ name: "photo", label: "Photo", type: "file" }),
    ]);
    expect(html).not.toContain("secret123");
    expect(html).not.toContain("hack.jpg");
  });

  test("restores textarea, select, and checkbox-group values", () => {
    setSavedFormData(new FormParams("notes=My+notes&color=blue&tags=a&tags=c"));

    const notesHtml = renderFields([field({ name: "notes", label: "Notes", type: "textarea" })]);
    expect(notesHtml).toContain("My notes");

    const selectHtml = renderFields([
      field({
        name: "color",
        label: "Color",
        type: "select",
        options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }],
      }),
    ]);
    expect(selectHtml).toContain('value="blue" selected');

    const checkboxHtml = renderFields([
      field({
        name: "tags",
        label: "Tags",
        type: "checkbox-group",
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }],
      }),
    ]);
    expect(checkboxHtml).toContain('value="a" checked');
    expect(checkboxHtml).not.toContain('value="b" checked');
    expect(checkboxHtml).toContain('value="c" checked');
  });

  test("restores datetime date and time separately", () => {
    setSavedFormData(new FormParams("start_date=2026-03-21&start_time=14%3A30"));
    const html = renderFields([field({ name: "start", label: "Start", type: "datetime" })]);
    expect(html).toContain('value="2026-03-21"');
    expect(html).toContain('value="14:30"');
  });

  test("defaults datetime time to 00:00 when only date was saved", () => {
    setSavedFormData(new FormParams("start_date=2026-03-21"));
    const html = renderFields([field({ name: "start", label: "Start", type: "datetime" })]);
    expect(html).toContain('value="2026-03-21"');
    expect(html).toContain('value="00:00"');
  });

  test("renders no value attributes for datetime when nothing was saved", () => {
    setSavedFormData(new FormParams("other=value"));
    const html = renderFields([field({ name: "start", label: "Start", type: "datetime" })]);
    expect(html).not.toContain('value="');
  });

  test("clearSavedFormData stops restoration", () => {
    setSavedFormData(new FormParams("name=Alice"));
    clearSavedFormData();
    expect(renderFields([field({ name: "name", label: "Name" })])).not.toContain("Alice");
  });

  test("renders no value attributes when nothing was saved", () => {
    expect(renderFields([field({ name: "name", label: "Name" })])).not.toContain('value="');
  });

  test("escapes HTML in saved values", () => {
    setSavedFormData(new FormParams("name=%3Cscript%3Ealert(1)%3C%2Fscript%3E"));
    const html = renderFields([field({ name: "name", label: "Name" })]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
