import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { extractFormEntries } from "#test-utils/test-browser.ts";

const paramsFromEntries = (html: string): URLSearchParams =>
  new URLSearchParams(extractFormEntries(html));

describe("TestBrowser form defaults", () => {
  it("submits checked checkboxes and radios with repeated default values", () => {
    const params = paramsFromEntries(`
      <input type="checkbox" name="features" value="email" checked>
      <input type="checkbox" name="features" value="sms">
      <input type="checkbox" name="features" value="push" checked>
      <input type="checkbox" name="implicit" checked>
      <input type="radio" name="plan" value="basic">
      <input type="radio" name="plan" value="pro" checked>
    `);

    expect(params.getAll("features")).toEqual(["email", "push"]);
    expect(params.get("implicit")).toBe("on");
    expect(params.get("plan")).toBe("pro");
  });

  it("keeps repeated successful text-like, select, and textarea controls", () => {
    const params = paramsFromEntries(`
      <input type="hidden" name="token" value="abc">
      <input name="tag" value="first">
      <input name="tag" value="second">
      <select name="choices" multiple>
        <option value="a" selected>A</option>
        <option value="b">B</option>
        <option value="c" selected>C</option>
      </select>
      <textarea name="notes">Hello &amp; goodbye</textarea>
    `);

    expect(params.get("token")).toBe("abc");
    expect(params.getAll("tag")).toEqual(["first", "second"]);
    expect(params.getAll("choices")).toEqual(["a", "c"]);
    expect(params.get("notes")).toBe("Hello & goodbye");
  });

  it("excludes disabled controls across supported control types", () => {
    const params = paramsFromEntries(`
      <input name="enabled" value="yes">
      <input name="disabled_text" value="no" disabled>
      <input type="hidden" name="disabled_hidden" value="no" disabled>
      <input type="checkbox" name="disabled_checkbox" value="no" checked disabled>
      <input type="radio" name="disabled_radio" value="no" checked disabled>
      <select name="disabled_select" disabled><option value="no" selected>No</option></select>
      <textarea name="disabled_textarea" disabled>No</textarea>
      <button name="ignored" value="no">Submit</button>
    `);

    expect([...params.keys()]).toEqual(["enabled"]);
  });
});
