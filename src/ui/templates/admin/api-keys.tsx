/**
 * Admin API keys page template
 */

/* jscpd:ignore-start */
import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { apiKeyForm } from "#routes/admin/api-keys.ts";
import type { EndpointDoc } from "#shared/admin-api-example.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import {
  DeleteSection,
  GuideFooter,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { sectionsRenderer } from "#templates/components/aggregate-sections.tsx";
import { DataTable, namedColumns } from "#templates/components/data-table.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";

/* jscpd:ignore-end */

type ApiKeyDisplay = {
  id: number;
  name: string;
  created: string;
  lastUsed: string;
};

/** Render a last-used date, or "never" when the key has not been used. */
const lastUsedCell = (apiKey: ApiKeyDisplay): string =>
  apiKey.lastUsed
    ? new Date(apiKey.lastUsed).toLocaleDateString()
    : t("api_keys.never");

/** Render a created date as a locale-formatted date string. */
const createdCell = (apiKey: ApiKeyDisplay): string =>
  new Date(apiKey.created).toLocaleDateString();

const ApiKeyRow = ({ apiKey }: { apiKey: ApiKeyDisplay }): string =>
  String(
    <tr>
      <td>
        <a href={`/admin/api-keys/${apiKey.id}`}>{apiKey.name}</a>
      </td>
      <td>{createdCell(apiKey)}</td>
      <td>{lastUsedCell(apiKey)}</td>
    </tr>,
  );

// Every API-keys screen sits in the same admin shell. This wrapper keeps the
// active tab and page frame identical across the list, manage, and docs pages —
// only the title and body change.
const apiKeysShell = (
  session: AdminSession,
  title: string,
  children: Child,
): string => renderAdminPage("/admin/api-keys", session, title, children);

/**
 * Admin API keys page
 */
export const adminApiKeysPage = (
  keys: ApiKeyDisplay[],
  adminSession: AdminSession,
  opts: {
    success?: string | undefined;
    error?: string | undefined;
    newKey?: string | undefined;
  },
): string => {
  const keyRows =
    keys.length > 0
      ? pipe(
          map((k: ApiKeyDisplay) => ApiKeyRow({ apiKey: k })),
          joinStrings,
        )(keys)
      : `<tr><td colspan="3">${t("api_keys.no_keys")}</td></tr>`;

  return apiKeysShell(
    adminSession,
    t("api_keys.title"),
    <>
      <Flash error={opts.error} success={opts.success} />

      {opts.newKey && (
        <div class="warning">
          <strong>{t("api_keys.copy_notice")}</strong>
          <pre>
            <code>{opts.newKey}</code>
          </pre>
          <p>
            Use it with: <code>Authorization: Bearer YOUR_KEY</code>
          </p>
        </div>
      )}

      <p>
        <a href="/admin/api-keys/docs">{t("api_keys.docs_link")}</a>.
      </p>

      <DataTable
        columns={namedColumns("common.created", "api_keys.col.last_used")}
        rows={keyRows}
      />

      <br />

      <WritableOnly>
        <CsrfForm action="/admin/api-keys">
          <h2>{t("api_keys.create_legend")}</h2>
          <Raw html={apiKeyForm.render()} />
          <SubmitButton icon="plus">{t("api_keys.create_submit")}</SubmitButton>
        </CsrfForm>
      </WritableOnly>

      <GuideFooter href="/admin/guide#api">
        {t("api_keys.guide_link")}
      </GuideFooter>
    </>,
  );
};

/**
 * Per-key management page — the destination for the name link in the API keys
 * table. API keys aren't editable, so this read-only summary exists mainly to
 * host the delete action (moved off the table and behind a typed-name
 * confirmation).
 */
export const adminApiKeyManagePage = (
  apiKey: ApiKeyDisplay,
  session: AdminSession,
  opts: { error?: string | undefined; success?: string | undefined } = {},
): string =>
  apiKeysShell(
    session,
    `${t("api_keys.title")}: ${apiKey.name}`,
    <>
      <h1>{apiKey.name}</h1>
      <Flash error={opts.error} success={opts.success} />
      <DetailTable>
        <tr>
          <th>{t("common.created")}</th>
          <td>{createdCell(apiKey)}</td>
        </tr>
        <tr>
          <th>{t("api_keys.col.last_used")}</th>
          <td>{lastUsedCell(apiKey)}</td>
        </tr>
      </DetailTable>
      <WritableOnly>
        <DeleteSection
          heading={t("common.delete")}
          href={`/admin/api-keys/${apiKey.id}/delete`}
        >
          {t("api_keys.delete_submit")}
        </DeleteSection>
      </WritableOnly>
    </>,
  );

/**
 * Admin API key delete confirmation page
 */
export const adminDeleteApiKeyPage = (
  apiKey: { id: number; name: string },
  session: AdminSession,
): string =>
  ConfirmPage({
    action: `/admin/api-keys/${apiKey.id}/delete`,
    active: "/admin/api-keys",
    buttonText: t("api_keys.delete_submit"),
    children: (
      <>
        <p>{t("api_keys.delete_warning")}</p>
        <p>{t("api_keys.delete_confirm", { name: apiKey.name })}</p>
      </>
    ),
    label: t("api_keys.delete_label"),
    name: apiKey.name,
    session,
    title: `Delete: ${apiKey.name}`,
  });

/** A `<pre><code>…</code></pre>` block — the request/response payload
 *  container shared by every endpoint entry. */
const CodeBlock = ({ children }: { children: Child }): JSX.Element => (
  <pre>
    <code>{children}</code>
  </pre>
);

/** A labelled payload section: "<strong>Label:</strong>" then the code block. */
const PayloadBlock = ({
  label,
  body,
}: {
  label: string;
  body: string;
}): JSX.Element => (
  <>
    <p>
      <strong>{label}</strong>
    </p>
    <CodeBlock>{body}</CodeBlock>
  </>
);

const EndpointEntry = ({ endpoint }: { endpoint: EndpointDoc }): string =>
  String(
    <details>
      <summary>
        <code>
          {endpoint.method} {endpoint.path}
        </code>{" "}
        &mdash; {endpoint.description}
      </summary>
      {endpoint.request && (
        <PayloadBlock body={endpoint.request} label="Request:" />
      )}
      <PayloadBlock body={endpoint.response} label="Response:" />
    </details>,
  );

const EndpointList = ({ endpoints }: { endpoints: EndpointDoc[] }): string =>
  pipe(
    map((e: EndpointDoc) => EndpointEntry({ endpoint: e })),
    joinStrings,
  )(endpoints);

/** A related prose heading, intro, and body. The docs page renders three of
 * these (authentication, public API, admin API) with the same shell. */
type DocsSectionProps = {
  heading: string;
  intro: Child;
  children?: Child;
};

const DocsSection = (props: DocsSectionProps): JSX.Element => (
  <PageBlock>
    <div class="prose">
      <h3>{props.heading}</h3>
      <p>{props.intro}</p>
    </div>
    {props.children}
  </PageBlock>
);

/** One endpoint group on the docs page: its heading, intro line, and the
 * endpoints it documents. Modelled as data so the two groups (public, admin)
 * render through one shared fold. */
type EndpointDocsSection = DocsSectionProps & { endpoints: EndpointDoc[] };

/** Render the endpoint groups: each one is a DocsSection holding its
 * endpoint list. */
const endpointDocsSections = sectionsRenderer(
  ({ endpoints, ...section }: EndpointDocsSection) => (
    <DocsSection {...section}>
      <Raw html={EndpointList({ endpoints })} />
    </DocsSection>
  ),
);

/**
 * Admin API documentation page
 */
export const adminApiDocsPage = (
  session: AdminSession,
  publicEndpoints: EndpointDoc[],
  adminEndpoints: EndpointDoc[],
): string =>
  apiKeysShell(
    session,
    t("api_keys.docs_title"),
    <>
      <DocsSection
        heading={t("api_keys.authentication")}
        intro="Admin API endpoints require authentication via API key or session cookie:"
      >
        <CodeBlock>Authorization: Bearer YOUR_API_KEY</CodeBlock>
        <p>
          Public API endpoints require no authentication. All responses are
          JSON.
        </p>
      </DocsSection>

      {endpointDocsSections([
        {
          endpoints: publicEndpoints,
          heading: t("api_keys.public_api"),
          intro: t("api_keys.public_api_note"),
        },
        {
          endpoints: adminEndpoints,
          heading: t("api_keys.admin_api"),
          intro: (
            <>
              Requires <code>Authorization: Bearer YOUR_API_KEY</code> header.
            </>
          ),
        },
      ])}
    </>,
  );
