/**
 * Admin delivery settings page templates.
 *
 * The delivery page is owner-only. A single "has delivery" toggle sits at the
 * top; when enabled, the page reveals delivery-agent management (a simple
 * id + name list with add / edit / remove). Delivered listings then surface
 * drop-off and collection agent selectors on their attendees.
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
import type { AdminSession, DeliveryAgent } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideLink, SubmitButton } from "#templates/components/actions.tsx";
import { deliveryAgentFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** The has-delivery enable/disable toggle. */
const HasDeliveryForm = (hasDelivery: boolean): JSX.Element => (
  <CsrfForm action="/admin/delivery/has-delivery">
    <h2>Delivery</h2>
    <p>
      Enable delivery for equipment-hire style listings that are dropped off and
      collected from the customer's address. When on, listings gain a
      "Delivered" option and delivery agents can be managed below.
    </p>
    <fieldset class="radios">
      <label>
        <input
          checked={hasDelivery === true}
          name="has_delivery"
          type="radio"
          value="true"
        />
        Yes
      </label>
      <label>
        <input
          checked={hasDelivery !== true}
          name="has_delivery"
          type="radio"
          value="false"
        />
        No
      </label>
    </fieldset>
    <SubmitButton icon="save">Save</SubmitButton>
  </CsrfForm>
);

/** The delivery-agents list with inline add form (shown when delivery is on). */
const AgentsSection = (agents: DeliveryAgent[]): JSX.Element => (
  <article>
    <h2>Delivery Agents</h2>
    <p>
      Agents (typically vans) you can assign as the drop-off and collection
      agent on a delivered listing's attendees.
    </p>
    {agents.length === 0 ? (
      <p>No delivery agents yet.</p>
    ) : (
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr>
                <td>{agent.name}</td>
                <td>
                  <a href={`/admin/delivery/${agent.id}/edit`}>Edit</a>{" "}
                  <a href={`/admin/delivery/${agent.id}/delete`}>Delete</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    <CsrfForm action="/admin/delivery">
      <h3>Add Agent</h3>
      <Raw html={renderFields(deliveryAgentFields)} />
      <SubmitButton icon="plus">Add Agent</SubmitButton>
    </CsrfForm>
  </article>
);

/**
 * Admin delivery settings page — the has-delivery toggle plus, when enabled,
 * delivery-agent management.
 */
export const adminDeliveryPage = (
  agents: DeliveryAgent[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <Layout title="Delivery">
      <AdminNav active="/admin/delivery" session={session} />
      <Flash success={successMessage} />
      <p class="actions">
        <GuideLink href="/admin/guide#delivery">Delivery guide</GuideLink>
      </p>
      {HasDeliveryForm(settings.hasDelivery)}
      {settings.hasDelivery && AgentsSection(agents)}
    </Layout>,
  );

/** Delivery agent create/edit form values. */
export const deliveryAgentToFieldValues = (
  agent?: DeliveryAgent,
): Record<string, string | number | null> =>
  entityToFieldValues(agent, deliveryAgentFields, {});

/** Admin delivery-agent create page (linked from the inline form fallback). */
export const adminDeliveryAgentNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Add Delivery Agent">
      <AdminNav active="/admin/delivery" session={session} />
      <CsrfForm action="/admin/delivery">
        <h1>Add Delivery Agent</h1>
        <Flash error={error} />
        <Raw html={renderFields(deliveryAgentFields)} />
        <SubmitButton icon="plus">Create Agent</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/** Admin delivery-agent edit page. */
export const adminDeliveryAgentEditPage = (
  agent: DeliveryAgent,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Edit Delivery Agent">
      <AdminNav active="/admin/delivery" session={session} />
      <CsrfForm action={`/admin/delivery/agents/${agent.id}/edit`}>
        <h1>Edit Delivery Agent</h1>
        <Flash error={error} />
        <Raw
          html={renderFields(
            deliveryAgentFields,
            deliveryAgentToFieldValues(agent),
          )}
        />
        <SubmitButton icon="save">Save Changes</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/** Admin delivery-agent delete confirmation page. */
export const adminDeliveryAgentDeletePage = (
  agent: DeliveryAgent,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Delete Delivery Agent">
      <AdminNav active="/admin/delivery" session={session} />
      <ConfirmForm
        action={`/admin/delivery/agents/${agent.id}/delete`}
        buttonText="Delete Agent"
        danger={false}
        label="Agent name"
        name={agent.name}
      >
        <h1>Delete Delivery Agent</h1>
        <Flash error={error} />
        <p>
          Are you sure you want to delete the delivery agent{" "}
          <strong>{agent.name}</strong>? Any attendees assigned to this agent
          will have that assignment cleared.
        </p>
        <p>Type the agent name "{agent.name}" to confirm:</p>
      </ConfirmForm>
    </Layout>,
  );
