import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { TestBrowser } from "#test-utils/test-browser.ts";
import { postedPathBrowser, setupFormSubmit, useHandler } from "./helpers.ts";

describe("TestBrowser choosing which form a press belongs to", () => {
  it("presses a usable button in a later form, not the switched-off one", async () => {
    const { browser, postedPath } = postedPathBrowser();
    // A person reading this page can press the second Publish, so naming it
    // must reach that one rather than stopping at the switched-off first.
    browser.currentHtml = `
      <form action="/draft" method="POST">
        <button name="action" value="publish" disabled>Publish</button>
      </form>
      <form action="/ready" method="POST">
        <button name="action" value="publish">Publish</button>
      </form>
    `;

    await browser.submitForm({}, "Publish");

    expect(postedPath()).toBe("/ready");
  });

  it("prefers the form that renders every field being sent", async () => {
    const { browser, postedPath } = postedPathBrowser();
    // Two forms share the Save wording; only the second renders the field
    // being filled in, so that is the one a person would submit.
    browser.currentHtml = `
      <form action="/toggle" method="POST">
        <input type="checkbox" name="enabled" value="true">
        <button>Save</button>
      </form>
      <form action="/words" method="POST">
        <textarea name="intro"></textarea>
        <button>Save</button>
      </form>
    `;

    await browser.submitForm({ intro: "Welcome" }, "Save");

    expect(postedPath()).toBe("/words");
  });

  it("posts to the pressed button's formaction, like a real browser", async () => {
    const { browser, postedPath } = postedPathBrowser();
    // A quote button aims the same form at a different address; pressing it
    // must go where the button points, not where the form does.
    browser.currentHtml = `
      <form action="/book" method="POST">
        <input name="email" value="a@example.com">
        <button>Continue</button>
        <button formaction="/quote" type="submit">Show total</button>
      </form>
    `;

    await browser.submitForm({}, "Show total");

    expect(postedPath()).toBe("/quote");
  });

  it("ignores a data-formaction attribute when aiming the form", async () => {
    const { browser, postedPath } = postedPathBrowser();
    // Only the real formaction attribute may redirect the submission.
    browser.currentHtml = `
      <form action="/book" method="POST">
        <input name="email" value="a@example.com">
        <button data-formaction="/wrong" type="submit">Continue</button>
      </form>
    `;

    await browser.submitForm({}, "Continue");

    expect(postedPath()).toBe("/book");
  });

  it("ignores a data-name attribute when ranking forms by field", async () => {
    const { browser, postedPath } = postedPathBrowser();
    // Only a real name attribute counts as rendering the field — a longer
    // attribute like data-name on another form must not win the ranking.
    browser.currentHtml = `
      <form action="/decoy" method="POST">
        <div data-name="intro"></div>
        <button>Save</button>
      </form>
      <form action="/real" method="POST">
        <textarea name="intro"></textarea>
        <button>Save</button>
      </form>
    `;

    await browser.submitForm({ intro: "Welcome" }, "Save");

    expect(postedPath()).toBe("/real");
  });

  it("passes over a button written the same way inside a switched-off group", async () => {
    const { browser, postedPath } = postedPathBrowser();
    browser.currentHtml = `
      <form action="/switched-off" method="POST">
        <fieldset disabled><legend>Extras</legend>
          <button type="submit">Save</button>
        </fieldset>
      </form>
      <form action="/usable" method="POST">
        <button type="submit">Save</button>
      </form>
    `;

    await browser.submitForm({}, "Save");

    // The two buttons are written identically, so one cannot stand in for the
    // other: the one nobody could press is passed over on its own account.
    expect(postedPath()).toBe("/usable");
  });

  it("ranks forms by controls somebody could really fill in", async () => {
    const { browser, postedPath } = postedPathBrowser();
    browser.currentHtml = `
      <form action="/switched-off" method="POST">
        <fieldset disabled><legend>Extras</legend>
          <textarea name="intro"></textarea>
        </fieldset>
        <button type="submit">Save</button>
      </form>
      <form action="/usable" method="POST">
        <textarea name="intro"></textarea>
        <button type="submit">Save</button>
      </form>
    `;

    await browser.submitForm({ intro: "Hello" }, "Save");

    // A writing space nobody could type in is no reason to prefer its form.
    expect(postedPath()).toBe("/usable");
  });

  it("ranks forms by their real controls, not anything carrying a name", async () => {
    const { browser, postedPath } = postedPathBrowser();
    browser.currentHtml = `
      <form action="/decoy" method="POST">
        <div name="intro">About you</div>
        <button type="submit">Save</button>
      </form>
      <form action="/real" method="POST">
        <textarea name="intro"></textarea>
        <button type="submit">Save</button>
      </form>
    `;

    await browser.submitForm({ intro: "Hello" }, "Save");

    // A `<div name="intro">` is not something anybody types into, so the form
    // holding the real writing space is the one they would have used.
    expect(postedPath()).toBe("/real");
  });

  it("keeps the first matching form when nothing renders a sent field", async () => {
    const { browser, postedPath } = postedPathBrowser();
    // A field no form renders is a plain override, so form choice falls back
    // to the first form carrying the button, as it always did.
    browser.currentHtml = `
      <form action="/first" method="POST">
        <button>Save</button>
      </form>
      <form action="/second" method="POST">
        <button>Save</button>
      </form>
    `;

    await browser.submitForm({ extra: "override" }, "Save");

    expect(postedPath()).toBe("/first");
  });

  it("selects a buttonless form by its body text", async () => {
    const browser = new TestBrowser();
    let postedPath = "";
    let posted = "";
    useHandler(browser, async (request) => {
      postedPath = new URL(request.url).pathname;
      posted = await request.text();
      return new Response("saved");
    });
    // A form with no button at all is still one a person can send — pressing
    // Enter in the box does it — so its own words are how they would find it.
    browser.currentHtml = `
      <form action="/body-text" method="POST">
        <p>Publish this draft</p>
        <input name="title" value="Draft">
      </form>
    `;

    await browser.submitForm({}, "Publish");

    const params = new URLSearchParams(posted);
    expect(postedPath).toBe("/body-text");
    expect(params.get("title")).toBe("Draft");
  });

  it("refuses words that are on a form but on none of its buttons", async () => {
    const browser = new TestBrowser();
    let sent = false;
    useHandler(browser, () => {
      sent = true;
      return new Response("saved");
    });
    // The heading says Publish; the only button says Save. A person asked to
    // press Publish has no such button, so the form must not be sent — this is
    // how a story notices a button the page took away while its words stayed.
    browser.currentHtml = `
      <form action="/body-text" method="POST">
        <p>Publish this draft</p>
        <input name="title" value="Draft">
        <button name="action" value="save">Save</button>
      </form>
    `;

    await expect(browser.submitForm({}, "Publish")).rejects.toThrow(
      '"Publish" is on a form, but on none of its buttons',
    );
    expect(sent).toBe(false);
  });

  it("refuses the body-text send when the form's only submit button is switched off", async () => {
    const browser = new TestBrowser();
    let sent = false;
    useHandler(browser, () => {
      sent = true;
      return new Response("saved");
    });
    // A switched-off Save is still this form's first submit button, so
    // pressing Enter in the box would send nothing — the form is not one its
    // body text may stand in for.
    browser.currentHtml = `
      <form action="/body-text" method="POST">
        <p>Publish this draft</p>
        <input name="title" value="Draft">
        <button disabled>Save</button>
      </form>
    `;

    await expect(browser.submitForm({}, "Publish")).rejects.toThrow(
      '"Publish" is on a form, but on none of its buttons',
    );
    expect(sent).toBe(false);
  });

  it("reports a switched-off button over a form that merely mentions the words", async () => {
    const browser = new TestBrowser();
    // One form's Publish button is switched off; another only says Publish in
    // prose. The switched-off button is the more telling answer, whichever
    // order the two forms render in.
    const prose = `
      <form action="/prose" method="POST">
        <p>Publish this draft</p>
        <button>Save</button>
      </form>
    `;
    const switchedOff = `
      <form action="/off" method="POST">
        <button disabled>Publish</button>
      </form>
    `;
    for (const page of [prose + switchedOff, switchedOff + prose]) {
      browser.currentHtml = page;
      await expect(browser.submitForm({}, "Publish")).rejects.toThrow(
        'The "Publish" button is switched off',
      );
    }
  });

  it("passes over a form whose buttons say something else for one whose button says it", async () => {
    const { browser, postedPath } = postedPathBrowser();
    // The first form mentions Publish only in prose; the second has the real
    // button. The person would press the second form's button.
    browser.currentHtml = `
      <form action="/prose" method="POST">
        <p>Publish this draft</p>
        <button>Save</button>
      </form>
      <form action="/real" method="POST">
        <button>Publish</button>
      </form>
    `;

    await browser.submitForm({}, "Publish");

    expect(postedPath()).toBe("/real");
  });

  it("does not submit nameless button values", async () => {
    const { browser, getParams } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/save" method="POST">
        <input name="title" value="Draft">
        <button value="publish">Publish</button>
      </form>
    `;

    await browser.submitForm({}, "Publish");

    const params = getParams();
    expect(params.get("title")).toBe("Draft");
    expect(params.has("undefined")).toBe(false);
  });

  it("presses a usable button when a switched-off one shares its text", async () => {
    const browser = new TestBrowser();
    useHandler(browser, () => new Response("saved"));
    browser.currentHtml = `
      <form action="/only" method="POST">
        <button disabled>Save</button>
        <button name="action" value="now">Save</button>
      </form>
    `;

    await browser.submitForm({}, "Save");

    expect(browser.currentHtml).toBe("saved");
  });

  it("throws with available form actions when no button matches", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = `
      <form action="/first" method="POST"><button>Save</button></form>
      <form action="/second" method="POST"><button>Delete</button></form>
    `;

    await expect(browser.submitForm({}, "Publish")).rejects.toThrow(
      'No form found with button text "Publish". Available forms:\n  action="/first"\n  action="/second"',
    );
  });
});
