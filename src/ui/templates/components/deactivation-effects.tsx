/**
 * The four-line deactivation effect list the listing lifecycle page and the
 * group bulk-action page both show: three bullet effects, then the note that
 * existing attendees are untouched. Owning it here keeps the list from being
 * re-authored (and re-detected as a clone) per page.
 */

import type { Child } from "#jsx/jsx-runtime.ts";

export const DeactivationEffects = ({
  effect404,
  effectRegistrations,
  effectPayments,
  existingAttendeesNote,
}: {
  effect404: Child;
  effectRegistrations: Child;
  effectPayments: Child;
  existingAttendeesNote: Child;
}): JSX.Element => (
  <>
    <ul>
      <li>{effect404}</li>
      <li>{effectRegistrations}</li>
      <li>{effectPayments}</li>
    </ul>
    <p>{existingAttendeesNote}</p>
  </>
);
