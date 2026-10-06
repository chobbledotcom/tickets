import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { renderFields } from "#shared/forms/rendering.tsx";
import {
  clearSavedFormData,
  getSavedFormData,
  savedFormValue,
  savedFormValueOrNull,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import { field } from "#test-utils/field.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("saved form data", () => {
  test("restores text values across all non-sensitive field types", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("name=Alice&email=alice%40test.com"));
      const html = renderFields([
        field({ label: "Name", name: "name" }),
        field({ label: "Email", name: "email", type: "email" }),
      ]);
      expect(html).toContain('value="Alice"');
      expect(html).toContain('value="alice@test.com"');
    });
  });

  test("does not restore password or file fields", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("password=secret123&photo=hack.jpg"));
      const html = renderFields([
        field({ label: "Password", name: "password", type: "password" }),
        field({ label: "Photo", name: "photo", type: "file" }),
      ]);
      expect(html).not.toContain("secret123");
      expect(html).not.toContain("hack.jpg");
    });
  });

  test("restores textarea, select, and checkbox-group values", async () => {
    await withRequestContext(async () => {
      setSavedFormData(
        new FormParams("notes=My+notes&color=blue&tags=a&tags=c"),
      );

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
  });

  test("restores datetime date and time separately", async () => {
    await withRequestContext(async () => {
      setSavedFormData(
        new FormParams("start_date=2026-03-21&start_time=14%3A30"),
      );
      const html = renderFields([
        field({ label: "Start", name: "start", type: "datetime" }),
      ]);
      expect(html).toContain('value="2026-03-21"');
      expect(html).toContain('value="14:30"');
    });
  });

  test("defaults datetime time to 00:00 when only date was saved", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("start_date=2026-03-21"));
      const html = renderFields([
        field({ label: "Start", name: "start", type: "datetime" }),
      ]);
      expect(html).toContain('value="2026-03-21"');
      expect(html).toContain('value="00:00"');
    });
  });

  test("renders no value attributes for a datetime the stash cannot fill", async () => {
    // A stash with no datetime fields, or one holding a time without a date
    // (an incomplete datetime), yields no value rather than a lone time.
    for (const stash of ["other=value", "start_time=14%3A30"]) {
      await withRequestContext(async () => {
        setSavedFormData(new FormParams(stash));
        const html = renderFields([
          field({ label: "Start", name: "start", type: "datetime" }),
        ]);
        expect(html).not.toContain('value="');
      });
    }
  });

  test("clearSavedFormData stops restoration", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("name=Alice"));
      clearSavedFormData();
      expect(
        renderFields([field({ label: "Name", name: "name" })]),
      ).not.toContain('value="Alice"');
    });
  });

  test("renders no value attributes when nothing was saved", async () => {
    await withRequestContext(async () => {
      expect(
        renderFields([field({ label: "Name", name: "name" })]),
      ).not.toContain('value="');
    });
  });

  test("escapes HTML in saved values", async () => {
    await withRequestContext(async () => {
      setSavedFormData(
        new FormParams("name=%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
      );
      const html = renderFields([field({ label: "Name", name: "name" })]);
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>alert");
    });
  });

  test("empty explicit values defer to saved data", async () => {
    await withRequestContext(async () => {
      // Admin create/edit pages pass entityToFieldValues, which yields "" for a
      // blank field. That empty value must not shadow a restored submission.
      setSavedFormData(new FormParams("name=Restored"));
      const html = renderFields([field({ label: "Name", name: "name" })], {
        name: "",
      });
      expect(html).toContain('value="Restored"');
    });
  });

  test("empty explicit values stay empty when there is no saved data", async () => {
    await withRequestContext(async () => {
      const html = renderFields(
        [field({ defaultValue: "Default", label: "Name", name: "name" })],
        { name: "" },
      );
      expect(html).not.toContain('value="Default"');
    });
  });

  test("getSavedFormData returns the captured form", async () => {
    await withRequestContext(async () => {
      const form = new FormParams("name=Alice");
      setSavedFormData(form);
      expect(getSavedFormData()).toBe(form);
    });
  });

  test("getSavedFormData returns null once cleared", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("name=Alice"));
      clearSavedFormData();
      expect(getSavedFormData()).toBeNull();
    });
  });

  test("savedFormValueOrNull tells an absent field from an empty one", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("promo_code=&name=Ada"));
      expect(savedFormValueOrNull("name")).toBe("Ada");
      // An explicitly cleared field is the buyer's choice, not an absence.
      expect(savedFormValueOrNull("promo_code")).toBe("");
      expect(savedFormValueOrNull("phone")).toBeNull();
    });
  });

  test("savedFormValueOrNull refills exactly what was submitted", async () => {
    await withRequestContext(async () => {
      // Markdown indentation is meaning, so the refill keeps surrounding
      // spaces instead of trimming them away.
      setSavedFormData(new FormParams("note=%20%20indented%20%20"));
      expect(savedFormValueOrNull("note")).toBe("  indented  ");
      clearSavedFormData();
    });
  });

  test("savedFormValueOrNull answers null with no saved form", async () => {
    await withRequestContext(async () => {
      expect(savedFormValueOrNull("name")).toBeNull();
    });
  });

  test("savedFormValue answers the trimmed value, or empty with no form", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("name=%20Ada%20"));
      expect(savedFormValue("name")).toBe("Ada");
      clearSavedFormData();
      expect(savedFormValue("name")).toBe("");
    });
  });

  test("saved data set inside a scope stays within that scope", async () => {
    const scopedForm = new FormParams("name=Scoped");
    const inside = await withRequestContext(async () => {
      setSavedFormData(scopedForm);
      return getSavedFormData();
    });
    expect(inside).toBe(scopedForm);
    expect(getSavedFormData()).toBeNull(); // no leak outside the request
  });

  test("concurrent request scopes do not leak saved form data", async () => {
    const request = (name: string) =>
      withRequestContext(async () => {
        const form = new FormParams(`name=${name}`);
        setSavedFormData(form);
        // Yield so the two scopes interleave — no real timer needed.
        await Promise.resolve();
        return getSavedFormData()?.getString("name");
      });
    const [a, b] = await Promise.all([request("Alice"), request("Bob")]);
    expect(a).toBe("Alice");
    expect(b).toBe("Bob");
  });
});
