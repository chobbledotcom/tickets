import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ALL_CHECKBOXES } from "#test-utils/test-browser/forms.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";
import { recordingBrowser, setupFormSubmit, useHandler } from "./helpers.ts";

describe("TestBrowser sending a form", () => {
  it("submits successful controls, clicked button data, and user overrides", async () => {
    const browser = new TestBrowser();
    let posted:
      | {
          body: string;
          contentType: string | null;
          method: string;
          path: string;
        }
      | undefined;
    useHandler(browser, async (request) => {
      posted = {
        body: await request.text(),
        contentType: request.headers.get("content-type"),
        method: request.method,
        path: new URL(request.url).pathname,
      };
      return new Response("<p>saved</p>");
    });
    browser.currentHtml = `
      <form action="/save" method="POST">
        <input type="hidden" name="csrf_token" value="csrf">
        <input type="hidden" name="action" value="stale">
        <input name="name" value="Original">
        <input type="checkbox" name="features" value="email" checked>
        <input type="checkbox" name="features" value="sms">
        <input type="checkbox" name="features" value="push">
        <select name="status"><option value="draft">Draft</option></select>
        <textarea name="notes">From form</textarea>
        <button name="action" value="draft">Save draft</button>
        <button name="action" value="publish">Publish</button>
      </form>
    `;

    await browser.submitForm(
      {
        features: ALL_CHECKBOXES,
        name: "Updated",
        notes: ["line one", "line two"],
      },
      "Publish",
    );

    const params = new URLSearchParams(posted!.body);
    expect(posted).toMatchObject({
      contentType: "application/x-www-form-urlencoded",
      method: "POST",
      path: "/save",
    });
    expect(params.get("csrf_token")).toBe("csrf");
    expect(params.get("name")).toBe("Updated");
    expect(params.getAll("features")).toEqual(["email", "sms", "push"]);
    expect(params.get("status")).toBe("draft");
    expect(params.getAll("notes")).toEqual(["line one", "line two"]);
    // The hidden field and the pressed button share a name, and a browser sends
    // both — the hidden one where it sits, the button's after it.
    expect(params.getAll("action")).toEqual(["stale", "publish"]);
    expect(browser.currentHtml).toBe("<p>saved</p>");
  });

  it("submits the first form when no button text is supplied", async () => {
    const browser = new TestBrowser();
    let postedPath = "";
    useHandler(browser, async (request) => {
      postedPath = new URL(request.url).pathname;
      return new Response(await request.text());
    });
    browser.currentHtml = `
      <form action="/first" method="POST"><input name="first" value="1"></form>
      <form action="/second" method="POST"><input name="second" value="2"></form>
    `;

    await browser.submitForm({});

    expect(postedPath).toBe("/first");
    expect(browser.currentHtml).toBe("first=1");
  });

  it("throws clearly when submitting without button text and the page has no forms", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = "<main>No forms here</main>";

    await expect(browser.submitForm({})).rejects.toThrow(
      "No forms found on the current page",
    );
  });

  it("refuses to press a button the page has switched off", async () => {
    const { browser } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/disabled-button" method="POST">
        <input name="title" value="Draft">
        <button name="action" value="publish" disabled>Publish</button>
      </form>
    `;

    // Naming a button means pressing it. Submitting the form without its data
    // instead would let a test do something nobody looking at the page could.
    await expect(browser.submitForm({}, "Publish")).rejects.toThrow(
      'The "Publish" button is switched off',
    );
  });

  it("reads a button's own attributes, not longer ones ending the same way", async () => {
    const { browser, getParams } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/save" method="POST">
        <input name="title" value="Draft">
        <button data-name="row-3" data-value="7" name="action" value="publish">Publish</button>
      </form>
    `;

    await browser.submitForm({}, "Publish");

    // `data-name` and `data-value` are somebody else's attributes: the button
    // sends the name and value it really carries.
    expect(getParams().get("action")).toBe("publish");
    expect(getParams().get("row-3")).toBeNull();
  });

  it("refuses to press a button that sends nothing", async () => {
    const { browser } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/not-a-submitter" method="POST">
        <input name="title" value="Draft">
        <button type="button" name="action" value="publish">Publish</button>
      </form>
    `;

    // The button is there and nothing is stopping a click, but a
    // `type="button"` one sends no form — so this story would be proving the
    // site accepts something no visitor could give it.
    await expect(browser.submitForm({}, "Publish")).rejects.toThrow(
      'The "Publish" button sends nothing',
    );
  });

  /** A form sends the way the page says it does. The site serves real ones of
   * each — the attendee filter row and the listings date filter send by GET,
   * every form that changes something sends by POST — so a story submitting a
   * GET form by POST is asking the site something no visitor asked it. */
  const SENDS: Array<{
    method: string;
    sentAs: string;
    what: string;
  }> = [
    {
      method: ' method="POST"',
      sentAs: "POST",
      what: "sends a form that says POST by POST",
    },
    {
      method: ' method="get"',
      sentAs: "GET",
      what: "sends a form that says GET by GET",
    },
    {
      method: "",
      sentAs: "GET",
      what: "sends a form that says nothing by GET, as a browser does",
    },
  ];

  for (const sends of SENDS) {
    it(sends.what, async () => {
      const { browser, sent } = recordingBrowser();
      browser.currentHtml = `
        <form action="/search"${sends.method}>
          <input name="town" value="Leeds">
          <button type="submit">Search</button>
        </form>
      `;

      await browser.submitForm({}, "Search");

      expect(sent().method).toBe(sends.sentAs);
      expect(sent().path).toBe("/search");
      // Either way the values reach the site — in the address or in the body.
      const carried =
        sends.sentAs === "GET"
          ? new URLSearchParams(sent().query)
          : new URLSearchParams(sent().body);
      expect(carried.get("town")).toBe("Leeds");
      // A GET carries nothing in its body; a POST carries it all there.
      expect(sent().body).toBe(sends.sentAs === "GET" ? "" : "town=Leeds");
    });
  }

  it("refuses a form that says it sends a way no form can", async () => {
    const { browser, sent } = recordingBrowser();
    browser.currentHtml = `
      <form action="/save" method="POTS">
        <input name="town" value="Leeds">
        <button type="submit">Save</button>
      </form>
    `;

    // A browser sends a form with a misspelt method by GET. Sending it by POST
    // instead would let a story reach a POST-only route that no visitor
    // pressing that button could ever reach.
    await expect(browser.submitForm({}, "Save")).rejects.toThrow(
      'The form at "/save" says it sends by "pots", which is not a way a form can be sent',
    );
    expect(sent().method).toBe("");
  });

  it("puts a GET form where the address's own question marks were", async () => {
    const { browser, sent } = recordingBrowser();
    browser.currentHtml = `
      <form action="/search?page=7&town=Hull" method="get">
        <input name="town" value="Leeds">
        <button type="submit">Search</button>
      </form>
    `;

    await browser.submitForm({}, "Search");

    // A browser replaces the whole query rather than adding to it, so the
    // page=7 the address was carrying is gone — a well-known surprise, and one
    // a story should meet the same way a visitor would.
    expect(sent().query).toBe("?town=Leeds");
  });

  it("sends nothing for controls in a switched-off group", async () => {
    const { browser, getParams } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/save" method="POST">
        <input name="title" value="Draft">
        <fieldset disabled>
          <legend>Extras</legend>
          <input name="note" value="kept back">
          <input type="checkbox" name="agree" value="yes" checked>
        </fieldset>
        <button type="submit">Save</button>
      </form>
    `;

    await browser.submitForm({}, "Save");

    // A browser sends nothing from a switched-off group, however filled in it
    // looks, so neither does this.
    expect(getParams().get("title")).toBe("Draft");
    expect(getParams().get("note")).toBeNull();
    expect(getParams().get("agree")).toBeNull();
  });

  it("ticks every box on offer, and none in a switched-off group", async () => {
    const { browser, getParams } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/save" method="POST">
        <input type="checkbox" name="days" value="Monday">
        <fieldset disabled><legend>Extras</legend>
          <input type="checkbox" name="days" value="Sunday">
        </fieldset>
        <button type="submit">Save</button>
      </form>
    `;

    await browser.submitForm({ days: ALL_CHECKBOXES }, "Save");

    // Ticking them all means the ones on offer — a box in a switched-off group
    // is not one of them, however much it looks like the others.
    expect(getParams().getAll("days")).toEqual(["Monday"]);
  });

  it("refuses to press a button in a switched-off group", async () => {
    const { browser } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/save" method="POST">
        <input name="title" value="Draft">
        <fieldset disabled><legend>Extras</legend>
          <button type="submit">Save</button>
        </fieldset>
      </form>
    `;

    // The button is rendered and says nothing about itself, but its group is
    // switched off, so nobody could press it.
    await expect(browser.submitForm({}, "Save")).rejects.toThrow(
      'The "Save" button is switched off',
    );
  });

  it("downloads bytes without changing the current page", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = "<p>before</p>";
    browser.currentUrl = "/before";
    useHandler(browser, (request) => {
      expect(new URL(request.url).pathname).toBe("/file.zip");
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: new Headers([["set-cookie", "download=yes; Path=/"]]),
      });
    });

    const bytes = await browser.downloadBytes("/file.zip");

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(browser.currentHtml).toBe("<p>before</p>");
    expect(browser.currentUrl).toBe("/before");
    expect([...browser.debugCookies().entries()]).toEqual([
      ["download", "yes"],
    ]);
  });

  it("submits multipart form entries and file uploads", async () => {
    const browser = new TestBrowser();
    let formData: FormData | undefined;
    useHandler(browser, async (request) => {
      formData = await request.formData();
      return new Response("<p>uploaded</p>");
    });
    browser.currentHtml = `
      <form action="/upload" method="POST">
        <input type="hidden" name="csrf_token" value="csrf">
        <input name="title" value="Original">
        <button>Upload</button>
      </form>
    `;

    await browser.submitFormWithFile(
      "backup",
      "backup.zip",
      new Uint8Array([4, 5, 6]),
      { title: "Updated" },
      "Upload",
    );

    expect(formData!.get("csrf_token")).toBe("csrf");
    expect(formData!.get("title")).toBe("Updated");
    const file = formData!.get("backup");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("backup.zip");
    expect([...new Uint8Array(await (file as File).arrayBuffer())]).toEqual([
      4, 5, 6,
    ]);
    expect(browser.currentHtml).toBe("<p>uploaded</p>");
  });
});
