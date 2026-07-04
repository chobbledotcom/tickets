/**
 * Admin logistics settings page templates.
 *
 * The logistics page is owner-only. A single "has logistics" toggle sits at the
 * top; when enabled, the page reveals logistics-agent management (a simple
 * id + name list with add / edit / remove). Logistics listings then surface
 * start and end agent selectors on their attendees.
 *
 * The main settings page is hand-rolled (its has-logistics toggle + inline
 * agents list + add form don't fit the standard resource list shell), but the
 * agent create/edit/delete pages go through {@link defineAdminResourcePages}.
 * The edit page carries its assigned-users selector via the factory's typed
 * `TEditCtx`.
 */

import { t } from "#i18n";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm, entityToFieldValues, renderFields } from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminLevel,
  AdminSession,
  LogisticsAgent,
} from "#shared/types.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";
import { defineAdminResourcePages } from "#templates/admin/resource-pages.tsx";
import {
  GuideLink,
  SaveButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  CheckboxFieldset,
  CheckboxLabel,
} from "#templates/components/aggregate-sections.tsx";
import {
  type DataColumn,
  dataTable,
} from "#templates/components/data-table.tsx";
import { YesNoRadios } from "#templates/components/yes-no-radios.tsx";
import { logisticsAgentFields } from "#templates/fields.ts";

/** The has-logistics enable/disable toggle. */
const HasLogisticsForm = (hasLogistics: boolean): JSX.Element => (
  <CsrfForm action="/admin/logistics/has-logistics">
    <h2>{t("logistics.title")}</h2>
    <p>{t("logistics.enable_hint")}</p>
    <YesNoRadios name="has_logistics" on={hasLogistics} />
    {SaveButton()}
  </CsrfForm>
);

/** Single-column table of logistics agents (name linking to edit). */
const agentColumns: DataColumn<LogisticsAgent>[] = [
  {
    cell: (agent) => (
      <a href={`/admin/logistics/${agent.id}/edit`}>{agent.name}</a>
    ),
    header: t("common.name"),
  },
];

/** The logistics-agents list with inline add form (shown when logistics is on). */
const AgentsSection = (agents: LogisticsAgent[]): JSX.Element => (
  <article>
    <h2>{t("logistics.agents_heading")}</h2>
    <p>{t("logistics.agents_hint")}</p>
    {agents.length === 0 ? (
      <p>{t("logistics.no_agents_yet")}</p>
    ) : (
      dataTable(agentColumns)(agents)
    )}
    <CsrfForm action="/admin/logistics">
      <h3>{t("logistics.add_agent")}</h3>
      <Raw html={renderFields(logisticsAgentFields)} />
      <SubmitButton icon="plus">{t("logistics.add_agent")}</SubmitButton>
    </CsrfForm>
  </article>
);

/**
 * Admin logistics settings page — the has-logistics toggle plus, when enabled,
 * logistics-agent management.
 */
export const adminLogisticsPage = (
  agents: LogisticsAgent[],
  session: AdminSession,
  successMessage?: string,
): string =>
  successAdminPage(t("logistics.title"))(session, successMessage)(
    <>
      <p class="actions">
        <GuideLink href="/admin/guide#logistics">
          {t("logistics.guide_link")}
        </GuideLink>
      </p>
      {HasLogisticsForm(settings.hasLogistics)}
      {settings.hasLogistics && AgentsSection(agents)}
    </>,
  );

/** Logistics agent create/edit form values. */
export const logisticsAgentToFieldValues = (
  agent?: LogisticsAgent,
): Record<string, string | number | null> =>
  entityToFieldValues(agent, logisticsAgentFields, {});

/** A user that can be assigned to drive a logistics agent. */
export interface AgentUserOption {
  id: number;
  username: string;
  adminLevel: AdminLevel;
}

/** Checkbox list for picking which users drive this logistics agent. Any user
 * class can be assigned; the chosen ids submit under the repeated `user_ids`
 * field. */
type AgentUsersSelectorProps = {
  users: AgentUserOption[];
  selected: ReadonlySet<number>;
};

const AgentUsersSelector = ({
  users,
  selected,
}: AgentUsersSelectorProps): JSX.Element => (
  <CheckboxFieldset
    className="checkboxes listing-section"
    hint={t("logistics.assigned_users_hint")}
    legend={t("logistics.assigned_users")}
  >
    {users.length === 0 ? (
      <p>
        <em>{t("logistics.no_users_to_assign")}</em>
      </p>
    ) : (
      users.map((user) => (
        <CheckboxLabel
          checked={selected.has(user.id) || undefined}
          label={` ${user.username} (${user.adminLevel})`}
          name="user_ids"
          value={String(user.id)}
        />
      ))
    )}
  </CheckboxFieldset>
);

/** Edit-page runtime context: the assignable users and the ids already
 *  assigned to this agent. Forwarded to `renderEditExtra` by the factory. */
type AgentEditCtx = {
  users: AgentUserOption[];
  selected: ReadonlySet<number>;
};

const { deletePage, editPage, newPage } = defineAdminResourcePages<
  LogisticsAgent,
  AgentEditCtx
>({
  active: "/admin/settings",
  basePath: "/admin/logistics",
  delete: {
    confirm: (agent) => ({
      args: { name: escapeHtml(agent.name) },
      key: "logistics.delete_confirm",
    }),
    danger: false,
    heading: t("logistics.delete_logistics_agent"),
    label: t("logistics.agent_name"),
    name: (agent) => agent.name,
    prompt: (agent) => ({
      args: { name: agent.name },
      key: "logistics.type_name_to_confirm",
    }),
  },
  labels: {
    addHeading: t("logistics.add_logistics_agent"),
    addSubmit: t("logistics.create_agent"),
    addTitle: t("logistics.add_logistics_agent"),
    deleteButton: t("logistics.delete_agent"),
    deleteLabel: t("logistics.agent_name"),
    deleteTitle: t("logistics.delete_logistics_agent"),
    editHeading: t("logistics.edit_agent"),
    editTitle: t("logistics.edit_agent"),
    listTitle: t("logistics.title"),
  },
  renderEditExtra: (_agent, ctx) => (
    <AgentUsersSelector selected={ctx.selected} users={ctx.users} />
  ),
  renderFields: (agent) =>
    agent === undefined ? (
      <Raw html={renderFields(logisticsAgentFields)} />
    ) : (
      <fieldset class="listing-section">
        <legend>{t("logistics.agent_details")}</legend>
        <Raw
          html={renderFields(
            logisticsAgentFields,
            logisticsAgentToFieldValues(agent),
          )}
        />
      </fieldset>
    ),
});

/** Admin logistics-agent create page (linked from the inline form fallback). */
export const adminLogisticsAgentNewPage = newPage;

/** Admin logistics-agent edit page. Grouped into fieldsets: the agent's details
 *  and the users assigned to drive it. */
export const adminLogisticsAgentEditPage = (
  agent: LogisticsAgent,
  users: AgentUserOption[],
  selectedUserIds: ReadonlySet<number>,
  session: AdminSession,
  error?: string,
): string =>
  editPage(agent, session, error, {
    selected: selectedUserIds,
    users,
  });

/** Admin logistics-agent delete confirmation page. */
export const adminLogisticsAgentDeletePage = deletePage;
