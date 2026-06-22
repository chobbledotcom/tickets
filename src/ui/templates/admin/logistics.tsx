/**
 * Admin logistics settings page templates.
 *
 * The logistics page is owner-only. A single "has logistics" toggle sits at the
 * top; when enabled, the page reveals logistics-agent management (a simple
 * id + name list with add / edit / remove). Logistics listings then surface
 * start and end agent selectors on their attendees.
 */

import { t } from "#i18n";
import { settings } from "#shared/db/settings.ts";
import {
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminLevel,
  AdminSession,
  LogisticsAgent,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  DeleteSection,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { logisticsAgentFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** The has-logistics enable/disable toggle. */
const HasLogisticsForm = (hasLogistics: boolean): JSX.Element => (
  <CsrfForm action="/admin/logistics/has-logistics">
    <h2>{t("logistics.title")}</h2>
    <p>{t("logistics.enable_hint")}</p>
    <fieldset class="radios">
      <label>
        <input
          checked={hasLogistics === true}
          name="has_logistics"
          type="radio"
          value="true"
        />
        {t("common.yes")}
      </label>
      <label>
        <input
          checked={hasLogistics !== true}
          name="has_logistics"
          type="radio"
          value="false"
        />
        {t("common.no")}
      </label>
    </fieldset>
    <SubmitButton icon="save">{t("common.save")}</SubmitButton>
  </CsrfForm>
);

/** The logistics-agents list with inline add form (shown when logistics is on). */
const AgentsSection = (agents: LogisticsAgent[]): JSX.Element => (
  <article>
    <h2>{t("logistics.agents_heading")}</h2>
    <p>{t("logistics.agents_hint")}</p>
    {agents.length === 0 ? (
      <p>{t("logistics.no_agents_yet")}</p>
    ) : (
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr>
                <td>
                  <a href={`/admin/logistics/${agent.id}/edit`}>{agent.name}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  String(
    <Layout title={t("logistics.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <Flash success={successMessage} />
      <p class="actions">
        <GuideLink href="/admin/guide#logistics">
          {t("logistics.guide_link")}
        </GuideLink>
      </p>
      {HasLogisticsForm(settings.hasLogistics)}
      {settings.hasLogistics && AgentsSection(agents)}
    </Layout>,
  );

/** Logistics agent create/edit form values. */
export const logisticsAgentToFieldValues = (
  agent?: LogisticsAgent,
): Record<string, string | number | null> =>
  entityToFieldValues(agent, logisticsAgentFields, {});

/** Admin logistics-agent create page (linked from the inline form fallback). */
export const adminLogisticsAgentNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("logistics.add_logistics_agent")}>
      <AdminNav active="/admin/settings" session={session} />
      <CsrfForm action="/admin/logistics">
        <h1>{t("logistics.add_logistics_agent")}</h1>
        <Flash error={error} />
        <Raw html={renderFields(logisticsAgentFields)} />
        <SubmitButton icon="plus">{t("logistics.create_agent")}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/** A user that can be assigned to drive a logistics agent. */
export interface AgentUserOption {
  id: number;
  username: string;
  adminLevel: AdminLevel;
}

/** Checkbox list for picking which users drive this logistics agent. Any user
 * class can be assigned; the chosen ids submit under the repeated `user_ids`
 * field. */
const AgentUsersSelector = ({
  users,
  selected,
}: {
  users: AgentUserOption[];
  selected: ReadonlySet<number>;
}): JSX.Element => (
  <fieldset class="checkboxes listing-section">
    <legend>{t("logistics.assigned_users")}</legend>
    <p>
      <small>{t("logistics.assigned_users_hint")}</small>
    </p>
    {users.length === 0 ? (
      <p>
        <em>{t("logistics.no_users_to_assign")}</em>
      </p>
    ) : (
      users.map((user) => (
        <label>
          <input
            checked={selected.has(user.id) || undefined}
            name="user_ids"
            type="checkbox"
            value={String(user.id)}
          />
          {` ${user.username} (${user.adminLevel})`}
        </label>
      ))
    )}
  </fieldset>
);

/** Admin logistics-agent edit page. Grouped into fieldsets: the agent's details
 * and the users assigned to drive it. */
export const adminLogisticsAgentEditPage = (
  agent: LogisticsAgent,
  users: AgentUserOption[],
  selectedUserIds: ReadonlySet<number>,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("logistics.edit_agent")}>
      <AdminNav active="/admin/settings" session={session} />
      <CsrfForm action={`/admin/logistics/${agent.id}/edit`}>
        <h1>{t("logistics.edit_agent")}</h1>
        <Flash error={error} />
        <fieldset class="listing-section">
          <legend>{t("logistics.agent_details")}</legend>
          <Raw
            html={renderFields(
              logisticsAgentFields,
              logisticsAgentToFieldValues(agent),
            )}
          />
        </fieldset>
        <AgentUsersSelector selected={selectedUserIds} users={users} />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>
      <DeleteSection
        heading={t("common.delete")}
        href={`/admin/logistics/${agent.id}/delete`}
      >
        {t("logistics.delete_agent")}
      </DeleteSection>
    </Layout>,
  );

/** Admin logistics-agent delete confirmation page. */
export const adminLogisticsAgentDeletePage = (
  agent: LogisticsAgent,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("logistics.delete_logistics_agent")}>
      <AdminNav active="/admin/settings" session={session} />
      <ConfirmForm
        action={`/admin/logistics/${agent.id}/delete`}
        buttonText={t("logistics.delete_agent")}
        danger={false}
        label={t("logistics.agent_name")}
        name={agent.name}
      >
        <h1>{t("logistics.delete_logistics_agent")}</h1>
        <Flash error={error} />
        <p>
          <Raw
            html={t("logistics.delete_confirm", {
              name: escapeHtml(agent.name),
            })}
          />
        </p>
        <p>{t("logistics.type_name_to_confirm", { name: agent.name })}</p>
      </ConfirmForm>
    </Layout>,
  );
