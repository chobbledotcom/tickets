/**
 * Email sending, templates, and notifications.
 *
 * Supports multiple email providers via HTTP APIs:
 * Resend, Postmark, SendGrid, and Mailgun.
 *
 * Emails are rendered using Liquid templates with support
 * for custom confirmation and admin notification templates.
 *
 * @module
 */

export * from "#lib/email.ts";
export * from "#lib/business-email.ts";
export * from "#lib/email-renderer.ts";
export * from "#lib/ntfy.ts";
