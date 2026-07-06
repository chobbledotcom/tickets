/**
 * POST /admin/attendees/:attendeeId/logistics — save the Logistics tab.
 *
 * The address and pinned lat/lng go into the encrypted PII blob (everything
 * else in the blob is preserved); the start/end times/agents go onto the
 * booking rows. A validation failure re-renders the submitted form in place
 * at 400, like the Edit tab; a success PRG-redirects back to this tab.
 */

import { t } from "#i18n";
import {
  ATTENDEE_LOGISTICS_FORM_ID,
  buildAttendeeLogisticsData,
  LAT_FIELD,
  LNG_FIELD,
  type LogisticsFormErrors,
  type LogisticsFormValues,
  parseLogisticsPlan,
  withSubmittedPlan,
} from "#routes/admin/attendee-logistics.ts";
import {
  buildLogisticsTabData,
  storedFormLines,
} from "#routes/admin/attendee-logistics-tab.ts";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import {
  type LoadedAttendee,
  loadAttendeeForEdit,
} from "#routes/admin/attendee-page-data.ts";
import { AUTH_FORM, type AuthSession, withAuth } from "#routes/auth.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { updateAttendeePII } from "#shared/db/attendees.ts";
import { setLogisticsAssignments } from "#shared/db/logistics.ts";
import type { FormParams } from "#shared/form-data.ts";
import { parseCoordinatePair } from "#shared/validation/coordinates.ts";
import { AttendeeLogisticsPanel } from "#templates/admin/attendee-logistics-tab.tsx";
import { validateAddress } from "#templates/fields.ts";

/** Re-render the submitted form in place at 400 (validation failure). The
 * start/end selectors show the SUBMITTED choices, not the saved ones, so
 * fixing the address or pin never silently reverts the operator's times. */
const renderSubmittedLogistics = (
  session: AuthSession,
  attendeeId: number,
  form: FormParams,
  values: LogisticsFormValues,
  errors: LogisticsFormErrors,
): Promise<Response> =>
  attendeePage.renderPage(session, attendeeId, "logistics", {
    sections: async (entity) => {
      const data = await buildLogisticsTabData(entity, values, errors);
      const logistics =
        data.logistics &&
        withSubmittedPlan(
          data.logistics,
          parseLogisticsPlan(
            form,
            await storedFormLines(entity),
            new Set(data.logistics.agents.map((agent) => agent.id)),
          ),
        );
      return [
        {
          html: AttendeeLogisticsPanel({ data: { ...data, logistics } }),
          kind: "custom" as const,
        },
      ];
    },
    status: 400,
  });

/** Persist the submitted start/end selectors, mirroring exactly what the
 * panel rendered: when the selectors weren't shown (logistics off, no agents,
 * nothing delivered) nothing is parsed, so stored assignments survive. */
const saveLogisticsSelectors = async (
  entity: LoadedAttendee,
  form: FormParams,
): Promise<void> => {
  const lines = await storedFormLines(entity);
  const logistics = await buildAttendeeLogisticsData(lines, entity.attendee);
  if (!logistics) return;
  const plan = parseLogisticsPlan(
    form,
    lines,
    new Set(logistics.agents.map((agent) => agent.id)),
  );
  await setLogisticsAssignments(
    entity.attendee.id,
    plan.split,
    plan.perListing,
  );
};

/** Inner submit logic: validate → save blob + selectors → PRG. */
const handleLogisticsSubmit = async (
  attendeeId: number,
  session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const entity = await loadAttendeeForEdit(attendeeId);
  if (!entity) return notFoundResponse();

  const values: LogisticsFormValues = {
    address: form.getString("address"),
    lat: form.getString(LAT_FIELD),
    lng: form.getString(LNG_FIELD),
  };
  const addressError = validateAddress(values.address);
  const coords = parseCoordinatePair(values.lat, values.lng);
  if (addressError || !coords.ok) {
    return renderSubmittedLogistics(session, attendeeId, form, values, {
      addressError,
      locationError: coords.ok ? null : t("attendee_logistics.location_error"),
    });
  }

  const { attendee } = entity;
  await updateAttendeePII(attendeeId, {
    address: values.address,
    email: attendee.email,
    lat: coords.pin.lat,
    lng: coords.pin.lng,
    name: attendee.name,
    payment_id: attendee.payment_id,
    phone: attendee.phone,
    special_instructions: attendee.special_instructions,
    ticket_token: attendee.ticket_token,
  });
  await saveLogisticsSelectors(entity, form);
  await logActivity(
    `Attendee '${attendee.name}' logistics updated`,
    attendee.listing_id,
    attendeeId,
  );
  return redirect(
    attendeePage.path(attendeeId, "logistics"),
    t("attendee_logistics.saved", { value: attendee.name }),
    true,
    { formId: ATTENDEE_LOGISTICS_FORM_ID },
  );
};

/** Handle POST /admin/attendees/:attendeeId/logistics. */
export const handleAttendeeLogisticsPost: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/logistics"
> = (request, { attendeeId }) =>
  withAuth(request, AUTH_FORM, (session, form) =>
    handleLogisticsSubmit(attendeeId, session, form),
  );
