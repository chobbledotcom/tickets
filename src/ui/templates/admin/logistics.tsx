/**
 * Admin logistics settings page templates.
 *
 * The logistics page is owner-only. It provides logistics-agent management (a
 * simple id + name list with add / edit / remove). Logistics listings surface
 * start and end agent selectors on their attendees.
 *
 * The main settings page is hand-rolled (its has-logistics toggle + inline
 * agents list + add form don't fit the standard resource list shell), but the
 * agent create/delete pages go through {@link defineAdminResourcePages}. The
 * edit form is a panel in the logistics-agent entity page.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { adminPath, adminPattern } from "#shared/admin-surface.ts";
import type { FormRenderValuesFor } from "#shared/forms/definition.ts";
import { entityToFieldValues } from "#shared/forms/values.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type { AdminLevel, LogisticsAgent } from "#shared/types.ts";
import {
  recordEditPanel,
  successListPage,
} from "#templates/admin/admin-page.tsx";
import { defineAdminResourcePages } from "#templates/admin/resource-pages.tsx";
import { WritableLink, WritableOnly } from "#templates/admin/writable-only.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import {
  CheckboxFieldset,
  CheckboxLabel,
  SectionFieldset,
} from "#templates/components/aggregate-sections.tsx";
import { TitledArticle } from "#templates/components/page-structure.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";
import { logisticsAgentForm } from "#templates/fields/listing.ts";

/* jscpd:ignore-end */

/** Single-column table of logistics agents (name linking to edit). */
const agentColumns: TableColumn<LogisticsAgent>[] = [
  {
    cell: (agent) => (
      <WritableLink href={adminPath("logisticsAgent", { id: agent.id })}>
        {agent.name}
      </WritableLink>
    ),
    header: translatedTableHeader("common.name"),
    key: "name",
  },
];

/** The logistics-agents list with inline add form (shown when logistics is on). */
const AgentsSection = ({
  agents,
}: {
  agents: LogisticsAgent[];
}): JSX.Element => (
  <TitledArticle title={t("logistics.agents_heading")}>
    <p>{t("logistics.agents_hint")}</p>
    {agents.length === 0 ? (
      <p>{t("logistics.no_agents_yet")}</p>
    ) : (
      renderTable(defineTable(agentColumns), agents)
    )}
    <WritableOnly>
      <SaveForm
        action={adminPattern("logistics")}
        submitIcon="plus"
        submitLabel={t("logistics.add_agent")}
      >
        <SectionFieldset
          className="listing-section"
          legend={t("logistics.add_agent")}
        >
          <Raw html={logisticsAgentForm.render()} />
        </SectionFieldset>
      </SaveForm>
    </WritableOnly>
  </TitledArticle>
);

/**
 * Admin logistics settings page with logistics-agent management.
 */
export const adminLogisticsPage = successListPage<LogisticsAgent[]>(
  "logistics.title",
  adminPattern("logistics"),
  (agents) => (
    <>
      <AgentsSection agents={agents} />
      <GuideFooter href={`${adminPattern("guide")}#logistics`}>
        {t("logistics.guide_link")}
      </GuideFooter>
    </>
  ),
);

/** Logistics agent create/edit form values. */
export const logisticsAgentToFieldValues = (
  agent?: LogisticsAgent,
): Record<string, string | number | null> =>
  entityToFieldValues(agent, logisticsAgentForm.fields, {});

/** A user that can be assigned to drive a logistics agent. */
export interface AgentUserOption {
  adminLevel: AdminLevel;
  id: number;
  username: string;
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

export const logisticsAgentPages = defineAdminResourcePages<LogisticsAgent>({
  active: adminPattern("logistics"),
  basePath: adminPattern("logistics"),
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
    deleteTitle: t("logistics.delete_logistics_agent"),
    listTitle: t("logistics.title"),
  },
  renderFields: () => <Raw html={logisticsAgentForm.render()} />,
});

type LogisticsAgentRenderValues = FormRenderValuesFor<
  typeof logisticsAgentForm.fields
>;

/** The entity page's Edit tab, including the users assigned to drive it. */
export const LogisticsAgentEditPanel = ({
  agent,
  error,
  selectedUserIds,
  users,
  values,
}: {
  agent: LogisticsAgent;
  error?: string;
  selectedUserIds: ReadonlySet<number>;
  users: AgentUserOption[];
  values?: LogisticsAgentRenderValues;
}): JSX.Element =>
  recordEditPanel("logisticsEdit", t("common.save_changes"))(
    agent.id,
    error,
    <>
      <fieldset class="listing-section">
        <legend>{t("logistics.agent_details")}</legend>
        <Raw
          html={logisticsAgentForm.render(
            values ?? logisticsAgentToFieldValues(agent),
          )}
        />
      </fieldset>
      <AgentUsersSelector selected={selectedUserIds} users={users} />
    </>,
  );
