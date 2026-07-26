import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
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
    deleteLabel: "Widget name",
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

  test("renders the synthetic list schema and writable row link", () => {
    const html = listPage(
      [entity, secondEntity],
      false,
      "Could not load widgets.",
      "Widgets loaded.",
    );

    expect(html).toContain("Could not load widgets.");
    expect(html).toContain("Widgets loaded.");
    expect(html).toContain(
      '<p data-list-intro="true">Manage synthetic widgets.</p>',
    );
    expect(html).toContain(
      '<th class="col-reorder">Order</th><th>Name</th><th>Code</th>',
    );
    expect(html).toContain(
      '<a href="/admin/widgets/17/edit">Widget &amp; One</a>',
    );
    expect(html).toContain("<td>W-17</td>");
    expect(html).toContain('action="/admin/widgets/17/move-down"');
    expect(html).toContain('action="/admin/widgets/18/move-up"');
    expect(html).toContain(
      '<a href="/admin/widgets/new">Add synthetic widget</a>',
    );
    expect(html).toContain(
      '<p data-guide-footer="true">Synthetic widget guide</p>',
    );
  });

  test("renders the configured empty state instead of a table", () => {
    const html = listPage([], false);

    expect(html).toContain("<p>No synthetic widgets.</p>");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("W-17");
  });

  test("turns the name into text and hides actions in read-only mode", () => {
    const html = listPage([entity], true);

    expect(html).toContain("<span>Widget &amp; One</span>");
    expect(html).not.toContain('href="/admin/widgets/17/edit"');
    expect(html).not.toContain('href="/admin/widgets/new"');
    expect(html).not.toContain('class="col-reorder"');
    expect(html).not.toContain("/move-");
    expect(html).toContain("Synthetic widget guide");
  });

  test("renders the create form from the synthetic field callback", () => {
    const html = pages.newPage(OWNER_SESSION, "Widget name is required.");

    expect(html).toContain('action="/admin/widgets"');
    expect(html).toContain("Widget name is required.");
    expect(html).toContain("<h1>Add synthetic widget</h1>");
    expect(html).toContain(
      '<input name="widget_name" type="text" value="new widget">',
    );
    expect(html).toContain("Create synthetic widget");
    expect(html).toContain("/icons.svg#plus");
  });

  test("renders every configured delete detail and the dangerous submit", () => {
    const html = pages.deletePage(
      entity,
      OWNER_SESSION,
      "Widget did not match.",
    );

    expect(html).toContain('action="/admin/widgets/17/delete"');
    expect(html).toContain("Widget did not match.");
    expect(html).toContain("<h1>Delete synthetic widget</h1>");
    expect(html).toContain(
      'Type the status name "Widget &amp; One" to confirm deletion:',
    );
    expect(html).toContain(
      "Type the post name &quot;Widget &amp; One&quot; to confirm deletion.",
    );
    expect(html).toContain('<p data-delete-extra="true">Code: W-17</p>');
    expect(html).toContain(
      'name="confirm_identifier" placeholder="Widget &amp; One" required',
    );
    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toContain("Delete synthetic widget");
  });
});
