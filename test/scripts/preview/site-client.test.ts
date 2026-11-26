import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createSiteClient, type Send } from "#scripts/preview/site-client.ts";

const FORM = `<form method="post" action="/save">
  <input type="hidden" name="csrfToken" value="t&amp;1">
  <input type="text" name="title" value="A &lt;b&gt; &quot;c&quot; &#39;d&#39;">
  <input type="password" name="secret">
  <input type="checkbox" name="ticked" checked>
  <input type="checkbox" name="unticked">
  <input type="radio" name="choice" value="a" checked>
  <input type="radio" name="choice" value="b">
  <input name="untyped" value="u">
  <input type="text" name="off" value="x" disabled>
  <input type="submit" name="go" value="Go">
  <input type="text" value="nameless">
</form>
<form method="post" action="/other"><input type="hidden" name="o" value="1"></form>`;

/** A site that serves `FORM` on every GET and records each request. */
const site = (extra: (request: Request) => Response | null = () => null) => {
  const requests: Request[] = [];
  const send: Send = (request) => {
    requests.push(request.clone());
    const special = extra(request);
    if (special !== null) return Promise.resolve(special);
    return Promise.resolve(
      new Response(request.method === "GET" ? FORM : "saved"),
    );
  };
  return { requests, send };
};

const bodyOf = async (request: Request | undefined): Promise<string> =>
  (await request?.text()) ?? "";

/** What a browser sends for `FORM`, with some fields replaced: the name of the
 * case, the fields, and the entries of the body. */
/* jscpd:ignore-start -- static data, not code */
const BODIES: [
  name: string,
  fields: Record<string, string | null>,
  entries: [string, string][],
][] = [
  [
    "sends the entries that a browser sends, with each entity decoded",
    {},
    [
      ["csrfToken", "t&1"],
      ["title", `A <b> "c" 'd'`],
      ["secret", ""],
      ["ticked", "on"],
      ["choice", "a"],
      ["untyped", "u"],
    ],
  ],
  [
    "replaces a named field, adds a new one, and drops a null one",
    { added: "new", choice: "b", secret: "s3", ticked: null },
    [
      ["csrfToken", "t&1"],
      ["title", `A <b> "c" 'd'`],
      ["secret", "s3"],
      ["choice", "b"],
      ["untyped", "u"],
      ["added", "new"],
    ],
  ],
];
/* jscpd:ignore-end */

/** A page that offers no form that the client can send: the name of the case,
 * the page, the action asked for, and the error that the client gives. */
/* jscpd:ignore-start -- static data, not code */
const UNUSABLE_PAGES: [
  name: string,
  html: string,
  action: string,
  message: string,
][] = [
  [
    "lists a form that has no action as (none)",
    '<form method="post"></form>',
    "/save",
    "Forms: (none).",
  ],
  [
    "fails when the page has no form at all",
    "<p>none</p>",
    "/page",
    "Forms: none.",
  ],
  [
    "fails for a form that needs a multipart body",
    '<form action="/up" enctype="multipart/form-data"></form>',
    "/up",
    'The form with action "/up" needs multipart.',
  ],
];
/* jscpd:ignore-end */

describe("createSiteClient", () => {
  test("reads a page, with the status, the address it names, and its html", async () => {
    const { send } = site(
      () =>
        new Response("<p>x</p>", {
          headers: { location: "/next" },
          status: 302,
        }),
    );

    expect(await createSiteClient("https://s.example", send).get("/a")).toEqual(
      {
        html: "<p>x</p>",
        location: "/next",
        status: 302,
      },
    );
  });

  test("says that an answer names no address with null", async () => {
    const { send } = site();

    expect(
      (await createSiteClient("https://s.example", send).get("/a")).location,
    ).toBeNull();
  });

  for (const [name, fields, entries] of BODIES) {
    test(name, async () => {
      const { requests, send } = site();

      await createSiteClient("https://s.example", send).submit(
        "/page",
        fields,
        "/save",
      );

      expect(await bodyOf(requests[1])).toBe(
        new URLSearchParams(entries).toString(),
      );
    });
  }

  test("posts to the action of the form, to the same site, as a url-encoded form", async () => {
    const { requests, send } = site();

    await createSiteClient("https://s.example", send).submit(
      "/page",
      {},
      "/save",
    );

    const sent = requests[1];
    expect([
      sent?.method,
      sent?.url,
      sent?.headers.get("content-type"),
    ]).toEqual([
      "POST",
      "https://s.example/save",
      "application/x-www-form-urlencoded",
    ]);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/page");
  });

  test("finds the form by the address of the page when no action is named", async () => {
    const { requests, send } = site();

    await createSiteClient("https://s.example", send).submit("/save", {});

    expect(requests[1]?.url).toBe("https://s.example/save");
  });

  test("fails with the actions that the page offers when it has no such form", async () => {
    const { send } = site();

    await expect(
      createSiteClient("https://s.example", send).submit(
        "/page",
        {},
        "/nowhere",
      ),
    ).rejects.toThrow(
      'The page offers no form with action "/nowhere". Forms: /save, /other.',
    );
  });

  for (const [name, html, action, message] of UNUSABLE_PAGES) {
    test(name, async () => {
      const send: Send = () => Promise.resolve(new Response(html));

      await expect(
        createSiteClient("https://s.example", send).submit("/page", {}, action),
      ).rejects.toThrow(message);
    });
  }

  test("sends an empty body for a form that has no inputs", async () => {
    const requests: Request[] = [];
    const send: Send = (request) => {
      requests.push(request.clone());
      return Promise.resolve(new Response('<form action="/empty"></form>'));
    };

    await createSiteClient("https://s.example", send).submit("/empty", {});

    expect(await bodyOf(requests[1])).toBe("");
  });

  test("keeps the cookies that the site sets, and drops the ones that it expires", async () => {
    const { requests, send } = site((request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/set") {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/; Secure");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response("", { headers });
      }
      if (pathname === "/expire") {
        return new Response("", {
          headers: { "set-cookie": "a=; Max-Age=0; Path=/" },
        });
      }
      return null;
    });
    const client = createSiteClient("https://s.example", send);

    await client.get("/set");
    await client.get("/expire");
    await client.get("/after");

    expect(requests.map((request) => request.headers.get("cookie"))).toEqual([
      null,
      "a=1; b=2",
      "b=2",
    ]);
  });
});
