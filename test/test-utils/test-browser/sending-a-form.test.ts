import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ALL_CHECKBOXES } from "#test-utils/test-browser/forms.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";
import { setupFormSubmit, useHandler } from "./helpers.ts";

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
      <form action="/save">
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
    expect(params.get("action")).toBe("publish");
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
      <form action="/first"><input name="first" value="1"></form>
      <form action="/second"><input name="second" value="2"></form>
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
      <form action="/disabled-button">
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

  it("refuses to press a button that sends nothing", async () => {
    const { browser } = setupFormSubmit();
    browser.currentHtml = `
      <form action="/not-a-submitter">
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
      <form action="/upload">
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
