/**
 * Admin logistics settings page templates.
 *
 * The logistics page is owner-only. A single "has logistics" toggle sits at the
 * top; when enabled, the page reveals logistics-agent management (a simple
 * id + name list with add / edit / remove). Logistics listings then surface
 * start and end agent selectors on their attendees.
 */

import { settings } from "#shared/db/settings.ts";
import {
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminLevel,
  AdminSession,
  LogisticsAgent,
} from "#shared/types.ts";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
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
    <h2>Logistics</h2>
    <p>
      Enable logistics for listings handled by an agent at the customer's
      location — deliveries, equipment hire, transport, set-up and teardown.
      When on, listings gain a "Needs logistics" option and logistics agents can
      be managed below.
    </p>
    <fieldset class="radios">
      <label>
        <input
          checked={hasLogistics === true}
          name="has_logistics"
          type="radio"
          value="true"
        />
        Yes
      </label>
      <label>
        <input
          checked={hasLogistics !== true}
          name="has_logistics"
          type="radio"
          value="false"
        />
        No
      </label>
    </fieldset>
    <SubmitButton icon="save">Save</SubmitButton>
  </CsrfForm>
);

/** The logistics-agents list with inline add form (shown when logistics is on). */
const AgentsSection = (agents: LogisticsAgent[]): JSX.Element => (
  <article>
    <h2>Logistics Agents</h2>
    <p>
      Agents (e.g. vans, drivers, or crew) you can assign as the start and end
      agent on a logistics listing's attendees.
    </p>
    {agents.length === 0 ? (
      <p>No logistics agents yet.</p>
    ) : (
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
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
      <h3>Add Agent</h3>
      <Raw html={renderFields(logisticsAgentFields)} />
      <SubmitButton icon="plus">Add Agent</SubmitButton>
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
    <Layout title="Logistics">
      <AdminNav active="/admin/logistics" session={session} />
      <SettingsSubNav />
      <Flash success={successMessage} />
      <p class="actions">
        <GuideLink href="/admin/guide#logistics">Logistics guide</GuideLink>
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
    <Layout title="Add Logistics Agent">
      <AdminNav active="/admin/logistics" session={session} />
      <CsrfForm action="/admin/logistics">
        <h1>Add Logistics Agent</h1>
        <Flash error={error} />
        <Raw html={renderFields(logisticsAgentFields)} />
        <SubmitButton icon="plus">Create Agent</SubmitButton>
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
    <legend>Assigned users</legend>
    <p>
      <small>
        These users see this agent's deliveries and collections on the
        deliveries page. Agent-class users can only see the deliveries page;
        owners and managers reach it from the Calendar menu.
      </small>
    </p>
    {users.length === 0 ? (
      <p>
        <em>No users to assign yet.</em>
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
    <Layout title="Edit Logistics Agent">
      <AdminNav active="/admin/logistics" session={session} />
      <CsrfForm action={`/admin/logistics/${agent.id}/edit`}>
        <h1>Edit Logistics Agent</h1>
        <Flash error={error} />
        <fieldset class="listing-section">
          <legend>Agent details</legend>
          <Raw
            html={renderFields(
              logisticsAgentFields,
              logisticsAgentToFieldValues(agent),
            )}
          />
        </fieldset>
        <AgentUsersSelector selected={selectedUserIds} users={users} />
        <SubmitButton icon="save">Save Changes</SubmitButton>
      </CsrfForm>
      <DeleteSection
        heading="Delete"
        href={`/admin/logistics/${agent.id}/delete`}
      >
        Delete Agent
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
    <Layout title="Delete Logistics Agent">
      <AdminNav active="/admin/logistics" session={session} />
      <ConfirmForm
        action={`/admin/logistics/${agent.id}/delete`}
        buttonText="Delete Agent"
        danger={false}
        label="Agent name"
        name={agent.name}
      >
        <h1>Delete Logistics Agent</h1>
        <Flash error={error} />
        <p>
          Are you sure you want to delete the logistics agent{" "}
          <strong>{agent.name}</strong>? Any attendees assigned to this agent
          will have that assignment cleared.
        </p>
        <p>Type the agent name "{agent.name}" to confirm:</p>
      </ConfirmForm>
    </Layout>,
  );
