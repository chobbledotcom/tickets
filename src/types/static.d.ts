/**
 * Type declarations for static file imports with text type
 */

declare module "*.svg" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}
