/**
 * Admin delivery settings + delivery-agent management — owner only.
 *
 * The delivery page (`/admin/delivery`) carries the has-delivery toggle and,
 * when enabled, a simple CRUD list of delivery agents. Agent CRUD reuses the
 * shared owner-CRUD handlers with the delivery page itself as the list view.
 */

import type { InValue } from "@libsql/client";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { settingsToggle } from "#routes/admin/settings-helpers.ts";
import { defineRoutes } from "#routes/router.ts";
import { clearDeliveryAgentReferences } from "#shared/db/delivery.ts";
import {
  type DeliveryAgentInput,
  deliveryAgentsTable,
  getAllDeliveryAgents,
} from "#shared/db/delivery-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import {
  adminDeliveryAgentDeletePage,
  adminDeliveryAgentEditPage,
  adminDeliveryAgentNewPage,
  adminDeliveryPage,
} from "#templates/admin/delivery.tsx";
import { deliveryAgentFields } from "#templates/fields.ts";

/** Handle POST /admin/delivery/has-delivery — owner only. */
export const handleHasDeliveryPost = settingsToggle({
  field: "has_delivery",
  label: "Delivery",
  redirectTo: "/admin/delivery",
  save: (v) => settings.update.hasDelivery(v),
});

/** Extract delivery agent input from validated form values. The `name` field
 * is required, so form validation already rejects blank/whitespace names. */
const extractDeliveryAgentInput = (
  values: Record<string, string | number | null>,
): DeliveryAgentInput => ({
  name: String(values.name),
});

/** Delivery agents resource for REST create/update/delete. Deleting an agent
 * first clears any booking references so no attendee points at a missing id. */
const deliveryAgentsResource = defineNamedResource({
  fields: deliveryAgentFields,
  nameField: "name",
  onDelete: async (id: InValue): Promise<void> => {
    await clearDeliveryAgentReferences(Number(id));
    await deliveryAgentsTable.deleteById(id);
  },
  table: deliveryAgentsTable,
  toInput: extractDeliveryAgentInput,
});

const crud = createOwnerCrudHandlers({
  getAll: getAllDeliveryAgents,
  getName: (a) => a.name,
  listPath: "/admin/delivery",
  renderDelete: adminDeliveryAgentDeletePage,
  renderEdit: adminDeliveryAgentEditPage,
  renderList: adminDeliveryPage,
  renderNew: adminDeliveryAgentNewPage,
  resource: deliveryAgentsResource,
  singular: "Delivery agent",
});

/** Delivery settings + agent routes. */
export const deliveryRoutes = defineRoutes({
  ...crud.routes,
  "POST /admin/delivery/has-delivery": handleHasDeliveryPost,
});
