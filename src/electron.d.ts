/** The slice of Electron the plugin touches. `electron` is external to the
 *  bundle (Obsidian provides it at runtime) and not a dev dependency. */
declare module "electron" {
  export const shell: { openPath(path: string): Promise<string> };
}
