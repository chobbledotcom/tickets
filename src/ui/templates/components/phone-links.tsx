/**
 * Inline `tel:` and WhatsApp links for a phone number (e.g. an attendee's).
 * The number is normalised (e.g. `07700 900000` → `+447700900000`) for the
 * link hrefs while the display keeps whatever was entered. Renders nothing
 * when the phone is blank; the links are dropped when the number has no
 * callable digits. Generic — usable anywhere a phone number is shown.
 */

import { phoneLinks } from "#shared/phone.ts";

export const PhoneLinks = ({
  phone,
  phonePrefix,
}: {
  phone: string;
  phonePrefix: string;
}): JSX.Element | null => {
  if (!phone) return null;
  const links = phoneLinks(phone, phonePrefix);
  return (
    <>
      {phone}
      {links && (
        <>
          {" "}
          <small>
            <a href={links.tel}>tel</a>{" "}
            <a href={links.whatsapp} rel="noopener" target="_blank">
              whatsapp
            </a>
          </small>
        </>
      )}
    </>
  );
};
