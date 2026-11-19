/**
 * Ticket generation: QR codes, SVG tickets, and Apple Wallet passes.
 *
 * - **QR codes** — SVG or PNG QR codes for check-in URLs
 * - **Tickets** — an SVG ticket file for the attachment, and a QR PNG for the
 *   email body
 * - **Apple Wallet** — `.pkpass` file generation with PKCS#7 signing
 *
 * @module
 */

export * from "#shared/apple-wallet.ts";
export * from "#shared/qr.ts";
export * from "#shared/svg-ticket.ts";
export * from "#shared/ticket-url.ts";
export * from "#shared/wallet-icons.ts";
