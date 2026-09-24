/** `?raw` imports inline a file's text into the bundle (esbuild `rawText`
 *  plugin in esbuild.config.mjs; Vite/Vitest support the suffix natively). */
declare module "*?raw" {
  const text: string;
  export default text;
}
