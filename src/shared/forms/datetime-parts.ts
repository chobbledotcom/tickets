/** The input names of one datetime field's two parts. The form renderer, the
 *  submitted value read and the client autofill share this spelling, so a
 *  renamed field cannot leave a selector behind. */

/** The date input name and the time input name for one datetime field. */
export const datetimePartNames = (
  name: string,
): { date: string; time: string } => ({
  date: `${name}Date`,
  time: `${name}Time`,
});
