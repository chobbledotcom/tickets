import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { crudRoutes, entityTabRoutes } from "#routes/admin/route-tables.ts";

const request = new Request("http://localhost/admin/things/7");

/** A fake page that records what renderTab was called with. */
const recordingPage = () => {
  const calls: [number, string][] = [];
  return {
    calls,
    renderTab: (_request: Request, id: number, tab: string) => {
      calls.push([id, tab]);
      return Promise.resolve(new Response("ok"));
    },
  };
};

describe("entityTabRoutes", () => {
  test("binds the detail and tab routes under the declared path", async () => {
    const page = recordingPage();
    const routes = entityTabRoutes("/admin/things/:id", page);
    expect(Object.keys(routes).toSorted()).toEqual([
      "GET /admin/things/:id",
      "GET /admin/things/:id/:tab",
    ]);
    await routes["GET /admin/things/:id"](request, { id: 7 });
    await routes["GET /admin/things/:id/:tab"](request, {
      id: 7,
      tab: "edit",
    });
    expect(page.calls).toEqual([
      [7, ""],
      [7, "edit"],
    ]);
  });

  test("reads the record from whichever parameter the path names", async () => {
    const page = recordingPage();
    const routes = entityTabRoutes("/admin/things/:thingId", page);
    expect(Object.keys(routes).toSorted()).toEqual([
      "GET /admin/things/:thingId",
      "GET /admin/things/:thingId/:tab",
    ]);
    await routes["GET /admin/things/:thingId"](request, { thingId: 3 });
    await routes["GET /admin/things/:thingId/:tab"](request, {
      tab: "activity",
      thingId: 3,
    });
    expect(page.calls).toEqual([
      [3, ""],
      [3, "activity"],
    ]);
  });

  test("finds the record parameter however short the path before it", () => {
    // The helper makes no assumption about what precedes the parameter, so a
    // one-character base binds exactly like an /admin/... one.
    const page = recordingPage();
    const routes = entityTabRoutes("x/:thingId", page);

    expect(Object.keys(routes).toSorted()).toEqual([
      "GET x/:thingId",
      "GET x/:thingId/:tab",
    ]);
  });

  test("refuses a path that names no record", () => {
    // Binding a list path here would serve the whole collection's URL to a
    // handler that wants one record's id, and read undefined for it.
    expect(() => entityTabRoutes("/admin/things", recordingPage())).toThrow(
      "Entity detail path names no record: /admin/things",
    );
  });

  test("refuses a path whose parameter is not its last part", () => {
    expect(() =>
      entityTabRoutes("/admin/things/:id/edit", recordingPage()),
    ).toThrow("Entity detail path names no record: /admin/things/:id/edit");
  });
});

describe("crudRoutes", () => {
  test("binds each handler under its standard route key", () => {
    const handler = (name: string) => () => Promise.resolve(new Response(name));
    const crud = {
      createPost: handler("createPost"),
      deleteGet: handler("deleteGet"),
      deletePost: handler("deletePost"),
      editPost: handler("editPost"),
      listGet: handler("listGet"),
      newGet: handler("newGet"),
    };
    const routes = crudRoutes("/admin/things", crud);
    expect(routes["GET /admin/things"]).toBe(crud.listGet);
    expect(routes["GET /admin/things/new"]).toBe(crud.newGet);
    expect(routes["GET /admin/things/:id/delete"]).toBe(crud.deleteGet);
    expect(routes["POST /admin/things"]).toBe(crud.createPost);
    expect(routes["POST /admin/things/:id/delete"]).toBe(crud.deletePost);
    expect(routes["POST /admin/things/:id/edit"]).toBe(crud.editPost);
    expect(Object.keys(routes)).toHaveLength(6);
  });
});
