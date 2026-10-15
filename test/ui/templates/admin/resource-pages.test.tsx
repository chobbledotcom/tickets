import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { escapeHtml } from "#jsx/escape-html.ts";
import {
  type AdminResourcePagesConfig,
  defineAdminResourcePages,
  writableNameColumn,
} from "#templates/admin/resource-pages.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import { says } from "#test-utils/says.ts";

type SyntheticResource = {
  code: string;
  id: number;
  name: string;
};

const entity: SyntheticResource = {
  code: "W-17",
  id: 17,
  name: "Widget & One",
};
const secondEntity: SyntheticResource = {
  code: "W-18",
  id: 18,
  name: "Widget Two",
};

const config: AdminResourcePagesConfig<SyntheticResource> = {
  active: "/admin/settings",
  basePath: "/admin/widgets",
  delete: {
    children: ({ code }) => <p data-delete-extra="true">Code: {code}</p>,
    confirm: ({ name }) => ({
      args: { name: escapeHtml(name) },
      key: "statuses.delete_confirm",
    }),
    danger: true,
    heading: "Delete synthetic widget",
    label: "Widget name",
    name: ({ name }) => name,
    prompt: ({ name }) => ({ args: { name }, key: "news.delete_prompt" }),
  },
  labels: {
    addHeading: "Add synthetic widget",
    addSubmit: "Create synthetic widget",
    addTitle: "New synthetic widget",
    deleteButton: "Delete synthetic widget",
    deleteTitle: "Delete synthetic widget",
    listTitle: "Synthetic widgets",
  },
  list: {
    actions: <a href="/admin/widgets/new">Add synthetic widget</a>,
    columns: [
      writableNameColumn(
        ({ id }) => `/admin/widgets/${id}/edit`,
        ({ name }) => name,
      ),
      {
        cell: ({ code }) => code,
        header: "Code",
        key: "code",
      },
    ],
    empty: <p>No synthetic widgets.</p>,
    guideFooter: <p data-guide-footer="true">Synthetic widget guide</p>,
    intro: <p data-list-intro="true">Manage synthetic widgets.</p>,
    reorder: {
      action:
        ({ id }) =>
        (direction) =>
          `/admin/widgets/${id}/move-${direction}`,
      header: "Order",
      titles: { down: "Move down", up: "Move up" },
    },
  },
  renderFields: (current) => (
    <input
      name="widget_name"
      type="text"
      value={current === undefined ? "new widget" : current.name}
    />
  ),
};

const pages = defineAdminResourcePages(config);

const listPage = (
  entities: SyntheticResource[],
  readOnly: boolean,
  error?: string,
  success?: string,
): string => {
  using _env = withEnv({
    READ_ONLY_FROM: readOnly ? "2020-01-01T00:00:00.000Z" : undefined,
  });
  return pages.listPage(entities, OWNER_SESSION, error, success);
};

describe("admin resource page factory", () => {
  beforeAll(setupAdminPageTest);

  test("the writable name column keys itself as the row's name", () => {
    const column = writableNameColumn<SyntheticResource>(
      (item) => `/edit/${item.id}`,
      (item) => item.name,
    );
    // The key names the column in the table's identity checks (uniqueness,
    // hidden keys, filters), so an empty key would break those silently.
    expect(column.key).toBe("name");
    const cell = String(column.cell(entity, undefined, 0, [entity]));
    says(cell, "/edit/17");
    says(cell, "Widget &amp; One");
  });

  test("renders the synthetic list schema and writable row link", () => {
    const html = listPage(
      [entity, secondEntity],
      false,
      "Could not load widgets.",
      "Widgets loaded.",
    );

    says(html, "Could not load widgets.");
    says(html, "Widgets loaded.");
    says(html, '<p data-list-intro="true">Manage synthetic widgets.</p>');
    says(html, '<th class="col-reorder">Order</th><th>Name</th><th>Code</th>');
    says(html, '<a href="/admin/widgets/17/edit">Widget &amp; One</a>');
    says(html, "<td>W-17</td>");
    says(html, 'action="/admin/widgets/17/move-down"');
    says(html, 'action="/admin/widgets/18/move-up"');
    says(html, '<a href="/admin/widgets/new">Add synthetic widget</a>');
    says(html, '<p data-guide-footer="true">Synthetic widget guide</p>');
  });

  test("renders the configured empty state instead of a table", () => {
    const html = listPage([], false);

    says(html, "<p>No synthetic widgets.</p>");
    assert(!html.includes("<table"));
    assert(!html.includes("W-17"));
  });

  test("turns the name into text and hides actions in read-only mode", () => {
    const html = listPage([entity], true);

    says(html, "<span>Widget &amp; One</span>");
    assert(!html.includes('href="/admin/widgets/17/edit"'));
    assert(!html.includes('href="/admin/widgets/new"'));
    assert(!html.includes('class="col-reorder"'));
    assert(!html.includes("/move-"));
    says(html, "Synthetic widget guide");
  });

  test("renders the create form from the synthetic field callback", () => {
    const html = pages.newPage(OWNER_SESSION, "Widget name is required.");

    says(html, 'action="/admin/widgets"');
    says(html, "Widget name is required.");
    says(html, "<h1>Add synthetic widget</h1>");
    says(html, '<input name="widget_name" type="text" value="new widget">');
    says(html, "Create synthetic widget");
    says(html, "/icons.svg#plus");
  });

  test("renders every configured delete detail and the dangerous submit", () => {
    const html = pages.deletePage(
      entity,
      OWNER_SESSION,
      "Widget did not match.",
    );

    says(html, 'action="/admin/widgets/17/delete"');
    says(html, "Widget did not match.");
    says(html, "<h1>Delete synthetic widget</h1>");
    says(html, 'Type the status name "Widget &amp; One" to confirm deletion:');
    says(
      html,
      "Type the post name &quot;Widget &amp; One&quot; to confirm deletion.",
    );
    says(html, '<p data-delete-extra="true">Code: W-17</p>');
    says(
      html,
      'name="confirm_identifier" placeholder="Widget &amp; One" required',
    );
    says(html, '<button class="danger" type="submit">');
    says(html, "Delete synthetic widget");
  });
});
