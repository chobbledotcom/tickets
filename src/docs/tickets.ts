/**
 * Ticket generation: QR codes, SVG tickets, and Apple Wallet passes.
 *
 * - **QR codes** — SVG-based QR code generation for check-in URLs
 * - **SVG tickets** — visual ticket images for email attachments
 * - **Apple Wallet** — `.pkpass` file generation with PKCS#7 signing
 *
 * @module
 */

export * from "#lib/apple-wallet.ts";
export * from "#lib/qr.ts";
export * from "#lib/svg-ticket.ts";
export * from "#lib/ticket-url.ts";
export * from "#lib/wallet-icons.ts";
