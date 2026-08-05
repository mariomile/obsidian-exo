import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Contratto dell'API cross-plugin — la superficie che ALTRI repo consumano.
 *
 * Sonar chiama `app.plugins.plugins.exo.askExo(query, autoSend, opts)` e ne
 * ridichiara la firma a mano (`sonar/src/ui/modal.ts:120`, interfaccia `ExoApi`).
 * È un mirror scritto a mano di una verità che vive qui: niente lo riallinea,
 * e un rename o un cambio di firma compila su entrambi i lati.
 *
 * Sonar guarda con `exoAvailable()`, quindi non crasha — degrada in silenzio,
 * che è il caso peggiore: la fragilità è mascherata da robustezza e non genera
 * mai un segnale.
 *
 * ⚠️ Rosso qui significa "aggiorna anche sonar", non "cambia l'asserzione".
 */

const main = readFileSync(join(__dirname, "..", "src", "main.ts"), "utf8");

describe("contratto cross-plugin", () => {
  it("askExo esiste con la firma che Sonar ridichiara", () => {
    // Sonar dichiara: askExo(query: string, autoSend?: boolean, opts?: { source?: string })
    const decl =
      /async askExo\(\s*query:\s*string,\s*autoSend\s*=\s*true,\s*opts\?:\s*\{\s*source\?:\s*string\s*\}\s*\)/;
    expect(
      decl.test(main),
      "La firma di askExo non combacia più con il mirror-type in " +
        "obsidian-sonar/src/ui/modal.ts (interfaccia ExoApi). Sonar continuerebbe a " +
        "compilare e degraderebbe in silenzio: aggiorna il mirror prima di procedere.",
    ).toBe(true);
  });

  it("askExo resta un metodo pubblico del plugin", () => {
    // Sonar risolve `plugins.exo.askExo` a runtime: renderlo privato non
    // romperebbe nulla a compile time, ma lo renderebbe irraggiungibile.
    expect(main).not.toMatch(/private\s+async\s+askExo/);
  });
});
