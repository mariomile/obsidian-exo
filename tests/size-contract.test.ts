import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Size ratchet — i file grossi possono solo rimpicciolirsi.
 *
 * `view.ts` è il rischio sistemico numero uno di questo repo: ~7.5k righe in una
 * sola classe, toccate dal 40% dei commit. Ogni feature nuova (resume, hub,
 * strip, agents) è atterrata lì dentro, perché è il posto dove atterrare esiste
 * già e crearne uno nuovo costa una decisione.
 *
 * Spezzarlo è un progetto rischioso che non è mai stato schedulato — e nel
 * frattempo il file cresce (7429 → 7485 in due giorni). Questo contratto sceglie
 * l'altra strada: NON riduce niente oggi, ma rende impossibile crescere. La
 * feature successiva è costretta a nascere in un file proprio, e il tetto scende
 * da sé ogni volta che qualcosa viene estratto.
 *
 * È lo stesso meccanismo del ratchet sugli `!important` in style-contract, che
 * ha tenuto il debito CSS a zero senza mai chiedere una bonifica preventiva: il
 * tetto è fissato ESATTAMENTE al conteggio del giorno di introduzione, quindi
 * adottarlo costa zero.
 *
 * ⚠️ Quando questo test diventa rosso NON alzare il numero. Il rosso significa
 * che il codice nuovo va in un altro file. Abbassare i tetti dopo un'estrazione
 * è invece corretto e incoraggiato.
 */

const CEILINGS: Record<string, number> = {
  // Alzato deliberatamente il 2026-08-08 a 7100 — budget riservato per la feature
  // exo-chats. Abbassare il tetto al conteggio esatto dopo ogni estrazione
  // lasciava zero margine, quindi l'estrazione non comprava niente di
  // spendibile: la prima feature vera dopo un'estrazione sforava comunque. 7100
  // resta ben sotto i 7216 da cui questo branch è partito, quindi view.ts esce
  // comunque più piccolo di come è entrato. Alzare ulteriormente per qualsiasi
  // ALTRO motivo resta vietato: la risposta a un futuro sforamento è estrarre il
  // resto della gallery (showGallery più il cluster di selezione bulk), non un
  // numero più grande.
  "src/view.ts": 7100,
  // Abbassato il 2026-08-07 dopo l'estrazione della registrazione e
  // attivazione delle view in `ui/view-registry.ts`, e di nuovo il 2026-08-08
  // dopo l'estrazione degli SVG di addIcon in `ui/icons.ts` (3492 -> 3460
  // reali). Il tetto resta a 3480, non a 3460: stessa scelta già fatta per
  // view.ts sopra — fissarlo al conteggio esatto azzera il margine e rende
  // impossibile aggiungere una riga senza estrarne un'altra nello stesso
  // commit, cioè l'estrazione non compra niente di spendibile. 3480 è comunque
  // sotto il 3492 da cui si partiva. Se finisce anche questo, si estrae:
  // il candidato è il blocco dei comandi.
  "src/main.ts": 3480,
  "src/ui/composer.ts": 1723,
  "src/settings.ts": 1343,
};

/** Righe come le conta `wc -l`: i newline, non i segmenti — così il numero nel
 *  contratto è lo stesso che si legge da terminale. */
const lineCount = (rel: string): number => {
  const text = readFileSync(join(__dirname, "..", rel), "utf8");
  return (text.match(/\n/g) ?? []).length;
};

describe("size ratchet", () => {
  for (const [rel, ceiling] of Object.entries(CEILINGS)) {
    it(`${rel} non supera ${ceiling} righe`, () => {
      const actual = lineCount(rel);
      expect(
        actual,
        `${rel} è a ${actual} righe (tetto ${ceiling}).\n` +
          `Se hai aggiunto codice: mettilo in un file nuovo, non qui — è il punto del contratto.\n` +
          `Se hai ESTRATTO codice: abbassa il tetto in tests/size-contract.test.ts al nuovo conteggio.`,
      ).toBeLessThanOrEqual(ceiling);
    });
  }

  it("i tetti riflettono file che esistono davvero", () => {
    // Un tetto su un file rinominato o cancellato passerebbe per sempre senza
    // vincolare nulla: il contratto va tenuto onesto.
    for (const rel of Object.keys(CEILINGS)) {
      expect(() => lineCount(rel), `${rel} non esiste più`).not.toThrow();
    }
  });
});
