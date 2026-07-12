/* Exo Queue — "Exo in tasca" via Obsidian Sync (2026-07-10, mobile #7 v1).
 *
 * Architettura remote-head SENZA infrastruttura: il telefono scrive una nota
 * richiesta in `_system/exo-queue/`; Obsidian Sync la porta sul desktop; qui
 * il watcher la esegue HEADLESS e READ-ONLY (runHeadlessPlaybook: tool di
 * lettura auto-consentiti, ogni mutazione negata) e appende la risposta
 * NELLA STESSA NOTA; Sync riporta la risposta al telefono. Nessun server,
 * nessun pairing: il vault è lo stato condiviso, Sync è il trasporto.
 * (Prior art: Claude Dispatch — ma qui il bus è Sync. Primo nell'ecosistema.)
 *
 * Contratto della nota richiesta:
 *   - qualsiasi .md nella cartella coda, corpo = prompt;
 *   - viene processata se il frontmatter NON contiene `exo-answered`;
 *   - la risposta è appesa come `## Risposta (Exo · read-only)` e il
 *     frontmatter riceve `exo-answered: <ISO>` — scrittura a TESTO GREZZO,
 *     mai processFrontMatter (rompe i wikilink non quotati).
 *   - errori: sezione `## Errore` + exo-answered comunque (niente retry loop).
 *
 * Guardie: flag busy in-memory (mai due drain concorrenti), max 3 richieste
 * per ciclo (anti-valanga dopo un sync arretrato), corpo non vuoto.
 */

import { Notice, TFile, TFolder, type App } from "obsidian";

import { runHeadlessPlaybook } from "./headless";
import type { MVASettings } from "./settings";

const MAX_PER_DRAIN = 3;

interface ParsedNote {
  /** Frontmatter block INCLUSO i delimitatori (o "" se assente). */
  fm: string;
  /** Corpo senza frontmatter. */
  body: string;
}

function parseNote(content: string): ParsedNote {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end >= 0) {
      const close = content.indexOf("\n", end + 1);
      const fmEnd = close >= 0 ? close + 1 : content.length;
      return { fm: content.slice(0, fmEnd), body: content.slice(fmEnd) };
    }
  }
  return { fm: "", body: content };
}

function isPending(content: string): boolean {
  const { fm, body } = parseNote(content);
  if (/^exo-answered:/m.test(fm)) return false;
  return body.trim().length > 0;
}

/** Inserisce `exo-answered` nel frontmatter (testo grezzo, wikilink-safe). */
function stampAnswered(note: ParsedNote, iso: string): string {
  const line = `exo-answered: ${iso}\n`;
  if (note.fm) {
    // fm = "---\n…\n---\n" → inserisci prima della riga di chiusura.
    const closeAt = note.fm.lastIndexOf("---");
    return note.fm.slice(0, closeAt) + line + note.fm.slice(closeAt) + note.body;
  }
  return `---\n${line}---\n` + note.body;
}

/** Conta le richieste pendenti nella coda (per il pannello Autonomy) —
 *  stesso criterio del drain: nota .md, corpo non vuoto, niente exo-answered. */
export async function countPendingQueue(app: App, settings: MVASettings): Promise<number> {
  const folder = app.vault.getAbstractFileByPath(settings.exoQueueFolder);
  if (!(folder instanceof TFolder)) return 0;
  let n = 0;
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    try {
      if (isPending(await app.vault.cachedRead(child))) n++;
    } catch {
      /* unreadable — skip */
    }
  }
  return n;
}

/** Un giro di drain della coda. Ritorna quante richieste ha evaso. */
export async function drainExoQueue(
  app: App,
  settings: MVASettings
): Promise<number> {
  const folder = app.vault.getAbstractFileByPath(settings.exoQueueFolder);
  if (!(folder instanceof TFolder)) return 0; // cartella assente = coda vuota
  const pending: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") pending.push(child);
  }
  // Ordine stabile: più vecchie prima (ctime), così le risposte arrivano FIFO.
  pending.sort((a, b) => a.stat.ctime - b.stat.ctime);

  let done = 0;
  for (const file of pending) {
    if (done >= MAX_PER_DRAIN) break;
    const content = await app.vault.read(file);
    if (!isPending(content)) continue;

    const { fm, body } = parseNote(content);
    const prompt = body.trim();
    const result = await runHeadlessPlaybook(app, settings, prompt);
    const iso = new Date().toISOString().slice(0, 16).replace("T", " ");

    const heading = result.ok ? "## Risposta (Exo · read-only)" : "## Errore";
    const answer = result.ok
      ? result.output || "*(risposta vuota)*"
      : `${result.error ?? "errore sconosciuto"}\n\n${result.output}`.trim();
    const next =
      stampAnswered({ fm, body }, iso).replace(/\s*$/, "") +
      `\n\n${heading}\n\n${answer}\n`;

    // Rileggi prima di scrivere: se la nota è cambiata durante l'esecuzione
    // (edit dal telefono mid-run), non sovrascrivere — la riprende il
    // prossimo drain sulla versione nuova.
    const latest = await app.vault.read(file);
    if (latest !== content) continue;
    await app.vault.modify(file, next);
    done++;
    new Notice(`Exo queue: risposta pronta → ${file.basename}`);
  }
  return done;
}
