import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  childWrites,
  contentWrites,
  imageWrites,
  moveWrites,
  recordArea,
} from "#shared/admin-surface/record-area.ts";

const STAFF = ["owner", "manager"] as const;
const OWNER = ["owner"] as const;

describe("recordArea", () => {
  test("derives the list, record page, and writes from the names", () => {
    expect(
      recordArea({ audience: STAFF, name: "widgets", singular: "widget" }),
    ).toStrictEqual({
      audience: STAFF,
      record: {
        detail: "widget",
        list: "widgets",
        newPage: true,
        remove: "widgetDelete",
      },
      view: { widget: "/admin/widgets/:id", widgets: "/admin/widgets" },
      write: {
        widgetDelete: { pattern: "/admin/widgets/:id/delete" },
        widgetEdit: "/admin/widgets/:id/edit",
        widgetNew: "/admin/widgets/new",
      },
    });
  });

  test("uses the base path, the prefix, the segments, and the delete audience it is given", () => {
    expect(
      recordArea({
        audience: STAFF,
        basePath: "/admin/site/gadgets",
        deleteAudience: OWNER,
        name: "gadgets",
        prefix: "gizmo",
        segments: ["extra"],
        singular: "gadget",
      }),
    ).toStrictEqual({
      audience: STAFF,
      record: {
        detail: "gadget",
        list: "gadgets",
        newPage: true,
        remove: "gizmoDelete",
      },
      segments: ["extra"],
      view: {
        gadget: "/admin/site/gadgets/:id",
        gadgets: "/admin/site/gadgets",
      },
      write: {
        gizmoDelete: {
          audience: OWNER,
          pattern: "/admin/site/gadgets/:id/delete",
        },
        gizmoEdit: "/admin/site/gadgets/:id/edit",
        gizmoNew: "/admin/site/gadgets/new",
      },
    });
  });

  test("falls back to the default path and prefix only when none is given", () => {
    // An empty base path or prefix is still a given one, and is kept.
    const area = recordArea({
      audience: STAFF,
      basePath: "",
      name: "bare",
      prefix: "",
      singular: "item",
    });
    expect(area.view).toStrictEqual({ bare: "", item: "/:id" });
    expect(Object.keys(area.write)).toEqual(["Delete", "Edit", "New"]);
  });

  test("lands a save on the record page, and the list too unless told not to", () => {
    const both = recordArea({
      audience: STAFF,
      name: "tags",
      saveToRecord: true,
      singular: "tag",
    });
    expect(both.view.tags).toStrictEqual({
      afterSave: "tag",
      pattern: "/admin/tags",
    });
    expect(both.write.tagEdit).toStrictEqual({
      afterSave: "tag",
      pattern: "/admin/tags/:id/edit",
    });

    const editOnly = recordArea({
      audience: STAFF,
      listAfterSave: false,
      name: "tags",
      saveToRecord: true,
      singular: "tag",
    });
    expect(editOnly.view.tags).toBe("/admin/tags");
    expect(editOnly.write.tagEdit).toStrictEqual({
      afterSave: "tag",
      pattern: "/admin/tags/:id/edit",
    });
  });

  test("lands only a list save on the record page when asked", () => {
    const listOnly = recordArea({
      audience: STAFF,
      listAfterSave: true,
      name: "tags",
      singular: "tag",
    });
    expect(listOnly.view.tags).toStrictEqual({
      afterSave: "tag",
      pattern: "/admin/tags",
    });
    expect(listOnly.write.tagEdit).toBe("/admin/tags/:id/edit");
  });

  test("leaves out each page the record does not have", () => {
    expect(
      recordArea({
        audience: STAFF,
        detailPage: false,
        editPage: false,
        name: "notes",
        newPage: false,
        singular: "note",
      }),
    ).toStrictEqual({
      audience: STAFF,
      view: { notes: "/admin/notes" },
      write: { noteDelete: { pattern: "/admin/notes/:id/delete" } },
    });
  });

  test("marks a record created on its list page", () => {
    const area = recordArea({
      audience: STAFF,
      name: "notes",
      newPage: false,
      singular: "note",
    });
    expect(area.record.newPage).toBe(false);
    expect(Object.keys(area.write)).toEqual(["noteDelete", "noteEdit"]);
  });

  test("adds the extra views and writes it is given", () => {
    const area = recordArea({
      audience: STAFF,
      extraViews: { noteHistory: "/admin/notes/:id/history" },
      extraWrites: { noteCopy: "/admin/notes/:id/copy" },
      name: "notes",
      singular: "note",
    });
    expect(area.view.noteHistory).toBe("/admin/notes/:id/history");
    expect(area.write.noteCopy).toBe("/admin/notes/:id/copy");
  });
});

describe("the shared write sets", () => {
  test("name each write under the record's own path", () => {
    expect({
      child: childWrites("answer", "/admin/questions/:id/answers", "answerId"),
      content: contentWrites("page", "/admin/pages/:id"),
      image: imageWrites("post", "/admin/posts/:id"),
      move: moveWrites("row", "/admin/rows/:id"),
    }).toStrictEqual({
      // Add a child, then edit, delete, and move one under its own path.
      child: {
        answerAdd: "/admin/questions/:id/answers",
        answerDelete: "/admin/questions/:id/answers/:answerId/delete",
        answerEdit: "/admin/questions/:id/answers/:answerId/edit",
        answerMoveDown: "/admin/questions/:id/answers/:answerId/move-down",
        answerMoveUp: "/admin/questions/:id/answers/:answerId/move-up",
      },
      // A content record gets its actions and its images.
      content: {
        pageActions: "/admin/pages/:id/actions",
        pageImages: "/admin/pages/:id/images",
        pageImagesUpload: "/admin/pages/:id/images/upload",
      },
      image: {
        postImages: "/admin/posts/:id/images",
        postImagesUpload: "/admin/posts/:id/images/upload",
      },
      move: {
        rowMoveDown: "/admin/rows/:id/move-down",
        rowMoveUp: "/admin/rows/:id/move-up",
      },
    });
  });
});
