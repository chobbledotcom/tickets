/** Booking-input rules shared by the surfaces that create or edit bookings:
 *  the admin form and the admin JSON API. Each rule lives here once, and every
 *  surface writes only its own refusal message around it. */

/** The per-purchase cap a booking line's quantity must respect: one line never
 *  books more places than its listing allows in a single purchase. */
export const quantityOverCap = (quantity: number, cap: number): boolean =>
  quantity > cap;
