/**
 * The Logistics tab panel: the address form with postcode search, the
 * latitude/longitude pin inputs with the map underneath, the shared
 * start/end selectors, and the "Other Attendees" list of bookings on the
 * same dates (hidden when there are none).
 *
 * The map and the "chosen address differs from what's typed" notice are
 * progressive enhancements (client/logistics-map.ts and
 * client/admin/address-lookup.ts); without JavaScript the form still edits
 * and saves everything.
 */

import { t } from "#i18n";
import {
  ATTENDEE_LOGISTICS_FORM_ID,
  type AttendeeLogisticsTabData,
  LAT_FIELD,
  LNG_FIELD,
  type OtherAttendeeLine,
} from "#routes/admin/attendee-logistics.ts";
import { formatDateRangeLabel } from "#shared/dates.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { LogisticsSection } from "#templates/admin/attendee-form.tsx";
import { Icon } from "#templates/components/actions.tsx";
import { AddressFieldWithLookup } from "#templates/components/address-field.tsx";
import { ErrorAlert } from "#templates/components/error.tsx";

/** One latitude/longitude input. The map script re-pins as these change. */
const CoordinateInput = ({
  labelKey,
  name,
  value,
}: {
  labelKey: string;
  name: string;
  value: string;
}): JSX.Element => (
  <label for={name}>
    {t(labelKey)}
    <input
      autocomplete="off"
      data-coordinate
      id={name}
      inputmode="decimal"
      name={name}
      type="text"
      value={value}
    />
  </label>
);

/** The pinned-location block: the pair of inputs and the map container. The
 * map stays hidden until there is a pin to show (the script reveals it as
 * soon as coordinates appear). */
const PinnedLocation = ({
  data,
}: {
  data: AttendeeLogisticsTabData;
}): JSX.Element => {
  const pinned = data.values.lat !== "" && data.values.lng !== "";
  return (
    <>
      <h3>{t("attendee_logistics.location_heading")}</h3>
      <p class="small">{t("attendee_logistics.location_hint")}</p>
      {data.locationError && <ErrorAlert>{data.locationError}</ErrorAlert>}
      <div class="location-inputs">
        <CoordinateInput
          labelKey="attendee_logistics.latitude"
          name={LAT_FIELD}
          value={data.values.lat}
        />
        <CoordinateInput
          labelKey="attendee_logistics.longitude"
          name={LNG_FIELD}
          value={data.values.lng}
        />
      </div>
      <div
        aria-label={t("attendee_logistics.map_label")}
        class="logistics-map"
        data-logistics-map
        hidden={!pinned}
        role="img"
      ></div>
    </>
  );
};

/** A leg's time and (drop-off or collection) label in the others table. */
const legLabel = (time: string): string => time || "—";

/** The "Other Attendees" list: everyone else booked on overlapping dates,
 * each linking to their own Logistics tab. Renders nothing when empty. */
const OtherAttendees = ({
  others,
}: {
  others: OtherAttendeeLine[];
}): JSX.Element | null => {
  if (others.length === 0) return null;
  return (
    <article>
      <h3>{t("attendee_logistics.others_heading")}</h3>
      <p class="small">{t("attendee_logistics.others_hint")}</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("attendee_logistics.col_attendee")}</th>
              <th>{t("terms.listing")}</th>
              <th>{t("attendee_logistics.col_dates")}</th>
              <th>{t("attendee_logistics.col_start")}</th>
              <th>{t("attendee_logistics.col_end")}</th>
            </tr>
          </thead>
          <tbody>
            {others.map((line) => (
              <tr>
                <td>
                  <a href={`/admin/attendees/${line.attendeeId}/logistics`}>
                    {line.name}
                  </a>
                </td>
                <td>
                  {line.listingName}
                  {line.quantity > 1 ? (
                    <span class="muted small"> ×{line.quantity}</span>
                  ) : null}
                </td>
                <td>{formatDateRangeLabel(line.startAt, line.endAt)}</td>
                <td>{legLabel(line.startTime)}</td>
                <td>{legLabel(line.endTime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
};

/** The whole Logistics tab: the save form, then the other attendees. */
export const AttendeeLogisticsPanel = ({
  data,
}: {
  data: AttendeeLogisticsTabData;
}): JSX.Element => (
  <>
    <CsrfForm
      action={`/admin/attendees/${data.attendee.id}/logistics`}
      id={ATTENDEE_LOGISTICS_FORM_ID}
    >
      <h3>{t("attendee_logistics.address_heading")}</h3>
      {data.addressError && <ErrorAlert>{data.addressError}</ErrorAlert>}
      <AddressFieldWithLookup address={data.values.address} />
      <output
        class="warning"
        data-address-diff
        data-diff-heading={t("attendee_logistics.diff_heading")}
        hidden
      ></output>

      <PinnedLocation data={data} />

      <LogisticsSection logistics={data.logistics} />

      <p class="form-actions">
        <button class="primary" type="submit">
          <Icon name="save" />
          <span>{t("attendee_logistics.save")}</span>
        </button>
      </p>
    </CsrfForm>
    <OtherAttendees others={data.others} />
  </>
);
