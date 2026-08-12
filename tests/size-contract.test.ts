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
  // Abbassato il 2026-08-10 da 7100 dopo l'estrazione annunciata dal commento
  // precedente: la gallery della cronologia — `showGallery`, `hideGallery`,
  // `toggleGallery`, il cluster di selezione bulk (bulk bar, free-session,
  // deleteSelected) e lo stato che ha esattamente la vita dell'overlay
  // (`galleryEl`, selezione, chip di filtro, snapshot delle sessioni su disco)
  // — vive ora in `ui/gallery-view.ts`. 7099 -> 6518 righe reali.
  // Il tetto resta a 6600, non a 6518: stessa scelta già motivata su main.ts
  // qui sotto — fissarlo al conteggio esatto azzera il margine e l'estrazione
  // non compra niente di spendibile. 82 righe sono un budget dichiarato per il
  // wiring che segue (strip/sidebar), non un permesso di ricrescita: alzare il
  // numero per qualsiasi ALTRO motivo resta vietato, e il prossimo candidato
  // all'estrazione è il blocco dei tab (renderTabs + working set).
  //
  // Abbassato il 2026-08-12: le tre note di prompt della memoria
  // (`memoryStoreNote`, `memoryStoreNoteProactive`, `agentFolderNote`) vivono ora
  // in `core/memory-prompts.ts`. Erano template di stringa puri, senza `this` e
  // senza Obsidian, con un solo call site a testa: stavano qui solo perche' qui
  // c'e' il call site. 6600 -> 6575 righe reali.
  // Il tetto scende a 6590, non a 6575: 15 righe sono il budget dichiarato per il
  // wiring della calibrazione della memoria che segue (cap per nota inlinata e
  // dedup per conversazione), non un permesso di ricrescita. Al conteggio esatto
  // il file era a ZERO margine, ed e' esattamente il caso in cui ogni riga nuova
  // costa un'estrazione nello stesso commit.
  "src/view.ts": 6590,
  // Abbassato il 2026-08-07 dopo l'estrazione della registrazione e
  // attivazione delle view in `ui/view-registry.ts`, e di nuovo il 2026-08-08
  // dopo l'estrazione degli SVG di addIcon in `ui/icons.ts` (3492 -> 3460
  // reali). Il tetto resta a 3480, non a 3460: stessa scelta già fatta per
  // view.ts sopra — fissarlo al conteggio esatto azzera il margine e rende
  // impossibile aggiungere una riga senza estrarne un'altra nello stesso
  // commit, cioè l'estrazione non compra niente di spendibile. 3480 è comunque
  // sotto il 3492 da cui si partiva. Se finisce anche questo, si estrae:
  // il candidato è il blocco dei comandi.
  //
  // Abbassato il 2026-08-11 (fase 4-5 del piano chat+cosmos): i comandi della
  // sidebar chat — `open-chat-list`, `retitle-chats` e il nuovo
  // `next-needs-you` — vivono ora in `ui/chat-commands.ts`, cioè esattamente
  // l'estrazione che il commento qui sopra indicava come prossima. 3480 -> 3474
  // righe reali. Il tetto resta a 3474, senza margine, e stavolta è la scelta
  // giusta e non un azzeramento: il blocco che cresce — i comandi — adesso ha
  // un file dove atterrare, quindi il margine non serve più qui.
  "src/main.ts": 3474,
  // Abbassato il 2026-08-11 dopo l'estrazione del merge command+skill del menu
  // `/` in `core/slash.ts` (`mergeSlashEntries`): la lista non è UI, è la
  // riconciliazione di due roster che si sovrappongono, e lì è testabile senza
  // montare il composer. 1723 -> 1718 righe reali.
  // Il tetto resta a 1720, non a 1718: stessa scelta motivata sui file qui
  // sopra. 2 righe sono il margine dichiarato per il prossimo provider di
  // autocomplete, non un permesso di ricrescita — il prossimo candidato
  // all'estrazione è il blocco `atItems` (ricerca note + agenti).
  "src/ui/composer.ts": 1720,
  // Abbassato il 2026-08-11: `BACKGROUND_MODEL_OPTIONS` è tornato a casa in
  // `core/model-options.ts`, il modulo che possiede già il catalogo dei modelli
  // per i picker — qui era un catalogo di prodotto parcheggiato in un file di
  // UI. 1348 -> 1337 righe reali, e il tetto scende comunque sotto il 1343 da
  // cui si partiva.
  // Il tetto resta a 1340, non a 1337: stessa scelta motivata su view.ts e
  // main.ts qui sopra. Al conteggio esatto questo file NON aveva margine, ed è
  // esattamente il caso in cui si è rotto — su una singola chiave di
  // `MVASettings`, che per costruzione non può stare in un altro file. 3 righe
  // sono il margine dichiarato per la prossima preferenza persistita, non un
  // permesso di ricrescita: la prossima feature che chiede più spazio qui
  // estrae lo schema (`MVASettings` + `DEFAULT_SETTINGS`) dal tab di settings.
  //
  // Abbassato il 2026-08-11: quell'estrazione è stata fatta. `MVASettings`,
  // `DEFAULT_SETTINGS` e `LEGACY_QUEUE_FOLDER` vivono ora in
  // `src/settings-schema.ts`; `settings.ts` li ri-esporta, così i ~6 importer
  // esterni non cambiano path. Il tab renderizza le impostazioni, lo schema È
  // le impostazioni: erano due file in uno. 1338 -> 1024 righe reali.
  // Il tetto resta a 1032, non a 1024: 8 righe sono il margine dichiarato per
  // il toggle che segue (agent browser), non un permesso di ricrescita — ogni
  // nuova CHIAVE di `MVASettings` ora costa righe in settings-schema.ts, non
  // qui.
  "src/settings.ts": 1032,
  // Aggiunto il 2026-08-12. Questo file era l'UNICO pannello del repo senza
  // tetto, e nell'ondata chat+cosmos e' passato da 859 a 1020 righe senza che
  // niente lo fermasse — mentre lo stesso commit ABBASSAVA quello di main.ts.
  // Il ratchet stava decidendo dove il codice non si scrive, non dove dovrebbe
  // andare.
  // Il tetto e' 870, non 865: 5 righe di margine dichiarato, come su view.ts e
  // main.ts. Il blocco estratto e' il menu della riga (`rowMenu`,
  // `promptRename`, `RenameChatModal`) -> `ui/chat-row-menu.ts`, scelto perche'
  // non legge NESSUNO stato mutabile del pannello: e' una funzione di una riga
  // piu' tre servizi. Il prossimo candidato, con lo stesso criterio, e' il
  // renderer della riga (`rowModel`, `buildRichRow`, `buildCompactRow` e i loro
  // helper): stessa proprieta', ~215 righe, e lascerebbe un guscio che possiede
  // solo lo stato vero (query, cursore, ordine, collapse).
  "src/ui/chat-list-view.ts": 870,
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
