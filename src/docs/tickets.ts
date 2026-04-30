/**
 * Ticket generation: QR codes, SVG tickets, and Apple Wallet passes.
 *
 * - **QR codes** — SVG-based QR code generation for check-in URLs
 * - **SVG tickets** — visual ticket images for email attachments
 * - **Apple Wallet** — `.pkpass` file generation with PKCS#7 signing
 *
 * @module
 */

export * from "#shared/apple-wallet.ts";
export * from "#shared/qr.ts";
export * from "#shared/svg-ticket.ts";
export * from "#shared/ticket-url.ts";
export * from "#shared/wallet-icons.ts";
