import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createApp,
  inProcess,
  overHttp,
  type Target,
} from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** A target that records each request it gets and answers from a script. */
const scripted = (
  answer: (request: Request) => Response,
): { requests: Request[]; target: Target } => {
  const requests: Request[] = [];
  return {
    requests,
    target: (request) => {
      requests.push(request.clone());
      return Promise.resolve(answer(request));
    },
  };
};

const page = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html" } });

/** A target that serves `form` on GET and answers any POST with `saved`. */
const formServer = (form: string, saved = "ok") =>
  scripted((request) => (request.method === "GET" ? page(form) : page(saved)));

/** A target that sets the cookie `routes` names for a path, and serves an
 * empty page for every other path. */
const cookieServer = (routes: Record<string, string>) =>
  scripted((request) => {
    const cookie = routes[new URL(request.url).pathname];
    return cookie === undefined
      ? page("x")
      : new Response("", { headers: { "set-cookie": cookie } });
  });

const FORM = `<form method="POST" action="/save">
  <input type="hidden" name="csrfToken" value="token-1">
  <input type="text" name="title" value="Old title">
</form>`;

describe("driver forms", () => {
  test("sends the hidden fields of the page, with the named fields replaced", async () => {
    const { requests, target } = formServer(FORM, "saved");
    const result = await createApp(target).submit(
      "/edit",
      { title: "New" },
      "/save",
    );
    expect(result.html).toBe("saved");
    const sent = requests[1]!;
    expect([sent.method, new URL(sent.url).pathname]).toEqual([
      "POST",
      "/save",
    ]);
    expect(sent.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(await sent.text()).toBe("csrfToken=token-1&title=New");
  });

  test("adds a field that the form does not hold, after the others", async () => {
    const { requests, target } = formServer(FORM);
    await createApp(target).submit("/save", { extra: "1" });
    expect(await requests[1]!.text()).toBe(
      "csrfToken=token-1&title=Old+title&extra=1",
    );
  });

  test("leaves out a field named with null, as an unticked box", async () => {
    const { requests, target } = formServer(FORM);
    await createApp(target).submit("/save", { gone: null, title: null });
    expect(await requests[1]!.text()).toBe("csrfToken=token-1");
  });

  test("sends multipart when the form asks for it", async () => {
    const multipart = FORM.replace(
      'method="POST"',
      'method="POST" enctype="multipart/form-data"',
    );
    const { requests, target } = formServer(multipart);
    await createApp(target).submit("/save", { title: "Pic" });
    const data = await requests[1]!.formData();
    expect([...data.entries()]).toEqual([
      ["csrfToken", "token-1"],
      ["title", "Pic"],
    ]);
  });

  test("presses a button by its formaction, and sends its name and value", async () => {
    const withButtons = FORM.replace(
      "</form>",
      `<button type="submit" formaction="/save/2/move" name="anchor" value="7">Up</button>
       <button type="submit" formaction="/save/2/drop">Drop</button>
       <button type="submit" formaction="/save/2/keep" name="go">Keep</button></form>`,
    );
    const { requests, target } = formServer(withButtons);
    const app = createApp(target);

    await app.submit("/edit", {}, "/save/2/move");
    await app.submit("/edit", {}, "/save/2/drop");
    await app.submit("/edit", {}, "/save/2/keep");

    expect(
      await Promise.all(
        [requests[1]!, requests[3]!, requests[5]!].map(async (sent) => [
          new URL(sent.url).pathname,
          await sent.text(),
        ]),
      ),
    ).toEqual([
      ["/save/2/move", "csrfToken=token-1&title=Old+title&anchor=7"],
      ["/save/2/drop", "csrfToken=token-1&title=Old+title"],
      ["/save/2/keep", "csrfToken=token-1&title=Old+title&go="],
    ]);
  });

  test("fails and lists the forms when the page offers no form with that action", async () => {
    const { target } = formServer(
      `${FORM}<form action="/other"></form><form></form>`,
    );
    await expect(
      createApp(target).submit("/edit", {}, "/missing"),
    ).rejects.toThrow(
      'The page offers no form with action "/missing". Forms: /save, /other, (none).',
    );
  });

  test("fails with none listed when the page holds no form", async () => {
    const { target } = formServer("<p>no form</p>");
    await expect(createApp(target).submit("/edit")).rejects.toThrow(
      'The page offers no form with action "/edit". Forms: none.',
    );
  });
});

describe("driver cookies", () => {
  test("keeps a cookie that a response sets, and sends it next time", async () => {
    const { requests, target } = cookieServer({
      "/in": "session=abc; Path=/; HttpOnly",
    });
    const app = createApp(target);
    await app.get("/in");
    await app.get("/next");
    expect(app.cookieHeader()).toBe("session=abc");
    expect(requests.map((sent) => sent.headers.get("cookie"))).toEqual([
      null,
      "session=abc",
    ]);
  });

  test("drops a cookie that a response expires", async () => {
    const { target } = cookieServer({
      "/in": "session=abc; Path=/",
      "/out": "session=; Max-Age=0; Path=/",
    });
    const app = createApp(target);
    await app.get("/in");
    await app.get("/out");
    expect(app.cookieHeader()).toBe("");
  });

  test("starts from a cookie header", async () => {
    const { requests, target } = cookieServer({});
    await createApp(target, "a=1; b=two=2").get("/");
    expect(requests[0]!.headers.get("cookie")).toBe("a=1; b=two=2");
  });

  test("reports a redirect without following it", async () => {
    const { requests, target } = scripted(
      () =>
        new Response(null, { headers: { location: "/admin" }, status: 302 }),
    );
    const result = await createApp(target).get("/go");
    expect([result.status, result.location, requests.length]).toEqual([
      302,
      "/admin",
      1,
    ]);
  });
});

describe("overHttp", () => {
  test("sends the path, the query, the cookie and the body to the origin, and follows no redirect", async () => {
    const seen: {
      body: string;
      cookie: string | null;
      method: string;
      url: string;
    }[] = [];
    const server = Deno.serve(
      { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
      async (request) => {
        seen.push({
          body: await request.text(),
          cookie: request.headers.get("cookie"),
          method: request.method,
          url: new URL(request.url).pathname + new URL(request.url).search,
        });
        return new Response(null, {
          headers: { location: "/elsewhere" },
          status: 302,
        });
      },
    );
    try {
      const origin = `http://127.0.0.1:${server.addr.port}`;
      const app = createApp(overHttp(origin), "session=abc");
      const got = await app.get("/a?b=1");
      expect([got.status, got.location]).toEqual([302, "/elsewhere"]);
      await createApp(overHttp(origin)).get("/x");
      const target = overHttp(origin);
      const posted = await target(
        new Request("http://localhost/p", { body: "k=v", method: "POST" }),
      );
      await posted.text();
      expect(seen).toEqual([
        { body: "", cookie: "session=abc", method: "GET", url: "/a?b=1" },
        { body: "", cookie: null, method: "GET", url: "/x" },
        { body: "k=v", cookie: null, method: "POST", url: "/p" },
      ]);
    } finally {
      await server.shutdown();
    }
  });
});

describeWithEnv("driver against the app", { db: true }, () => {
  test("shows the login form to a visitor who has not logged in", async () => {
    const result = await createApp(inProcess).get("/admin/");
    expect(result.status).toBe(200);
    expect(result.html).toContain('action="/admin/login"');
  });

  test("logs the owner in through the login form", async () => {
    const app = createApp(inProcess);
    const login = await app.logIn();
    expect(login.status).toBe(302);
    expect(app.cookieHeader()).not.toBe("");
    const after = await app.get("/admin/");
    expect(after.status).toBe(200);
    expect(after.html).not.toContain('action="/admin/login"');
  });

  test("keeps a visitor out when the password is wrong", async () => {
    const app = createApp(inProcess);
    await app.logIn("jo", "not-the-password");
    const after = await app.get("/admin/");
    expect(after.html).toContain('action="/admin/login"');
  });
});
