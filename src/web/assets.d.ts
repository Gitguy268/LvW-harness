// The web UI files are imported as text so the compiled binary carries them.
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*/web/app.js" {
  const text: string;
  export default text;
}
declare module "*.py" {
  const text: string;
  export default text;
}
declare module "*/vendor/model-viewer.min.js" {
  const text: string;
  export default text;
}
