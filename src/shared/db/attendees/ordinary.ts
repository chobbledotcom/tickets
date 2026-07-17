/** Keep attendee projections from exposing checkout work that is not booked yet. */
export const ordinaryAttendeeCondition = (attendeeAlias: string): string =>
  `NOT EXISTS (SELECT 1 FROM checkout_stages AS checkoutStage WHERE checkoutStage.attendee_id = ${attendeeAlias}.id)`;
