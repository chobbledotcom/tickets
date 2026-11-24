// effects: pure
/** One person a scanner door can still check in, as the door's name search
 * answers them. `quantity` counts the places they still owe on the door's
 * listings. `details` holds the door-safe facts that tell two people with the
 * same name apart. */
export type RosterOption = {
  attendeeId: number;
  details: string[];
  name: string;
  quantity: number;
};
