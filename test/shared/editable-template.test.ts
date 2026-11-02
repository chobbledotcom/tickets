import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { Liquid } from "liquidjs";
import { SafeHtml } from "#jsx/jsx-runtime.ts";
import {
  renderEditableTemplate,
  validateEditableTemplate,
} from "#shared/editable-template.ts";

describe("renderEditableTemplate", () => {
  test("renders the operator's template with the data it is given", async () => {
    const html = await renderEditableTemplate(
      { defaultTemplate: "Unused {{ name }}", template: "<b>{{ name }}</b>" },
      { name: "Alice" },
    );

    expect(html).toBe("<b>Alice</b>");
  });

  test("renders the built-in default when the box is blank", async () => {
    const html = await renderEditableTemplate(
      { defaultTemplate: "<b>{{ name }}</b>", template: " \n " },
      { name: "Alice" },
    );

    expect(html).toBe("<b>Alice</b>");
  });

  test("passes app-built markup through unescaped", async () => {
    // The caller escapes typed values itself. A ready-made fragment such as
    // the mark form is SafeHtml, so the engine keeps its markup intact.
    const html = await renderEditableTemplate(
      {
        defaultTemplate: "",
        template: "{{ mark_form }}",
      },
      { mark_form: new SafeHtml('<form action="/mark"></form>') },
    );

    expect(html).toBe('<form action="/mark"></form>');
  });
});

describe("validateEditableTemplate", () => {
  test("returns null for a template the engine can read", () => {
    expect(validateEditableTemplate("Hello {{ name }}")).toBeNull();
  });

  test("returns null for a template with a for loop", () => {
    expect(
      validateEditableTemplate("{% for x in items %}{{ x }}{% endfor %}"),
    ).toBeNull();
  });

  test("returns an error for an unclosed tag", () => {
    expect(validateEditableTemplate("{% for x in items %}{{ x }}")).not.toBe(
      null,
    );
  });

  test("returns an error for an unknown tag", () => {
    expect(validateEditableTemplate("{% invalid_tag %}")).not.toBeNull();
  });

  test("returns null for an empty template", () => {
    expect(validateEditableTemplate("")).toBeNull();
  });

  test("returns the message of a thrown value that is not an Error", () => {
    const parseStub = stub(Liquid.prototype, "parse", () => {
      throw "raw string parse error";
    });
    try {
      expect(validateEditableTemplate("anything")).toBe(
        "raw string parse error",
      );
    } finally {
      parseStub.restore();
    }
  });
});
