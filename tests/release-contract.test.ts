import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("public release contract", () => {
  it("keeps package, manifest, and versions metadata synchronized", () => {
    const manifest = readJson("manifest.json");
    const pkg = readJson("package.json");
    const versions = readJson("versions.json");

    expect(pkg.version).toBe(manifest.version);
    expect(versions[String(manifest.version)]).toBe(manifest.minAppVersion);
  });
});
