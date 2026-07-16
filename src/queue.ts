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
 *   - errori: fino a 3 tentativi con backoff persistito nel frontmatter;
 *     `exo-failed` chiude solo dopo l'ultimo fallimento.
 *
 * Guardie: flag busy in-memory (mai due drain concorrenti), max 3 richieste
 * per ciclo (anti-valanga dopo un sync arretrato), corpo non vuoto.
 */

import { Notice, TFile, TFolder, type App } from "obsidian";

import { runHeadlessPlaybook } from "./headless";
import type { MVASettings } from "./settings";
import { patchFrontmatter } from "./core/frontmatter-patch";

const MAX_PER_DRAIN = 3;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60 * 1000;

interface ParsedNote {
  /** Frontmatter block INCLUSO i delimitatori (o "" se assente). */
  fm: string;
  /** Corpo senza frontmatter. */
  body: string;
}

export function parseNote(content: string): ParsedNote {
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

export function queueRequestBody(body: string): string {
  return body.split(/\n## Errore \(Exo · tentativo \d+\/\d+\)\n/)[0].trim();
}

export function isPending(content: string): boolean {
  const { fm, body } = parseNote(content);
  if (/^exo-answered:/m.test(fm)) return false;
  if (/^exo-failed:/m.test(fm)) return false;
  return queueRequestBody(body).length > 0;
}

export function isQueueRetryDue(content: string, now = Date.now()): boolean {
  if (!isPending(content)) return false;
  const { fm } = parseNote(content);
  const raw = fm.match(/^exo-retry-after:\s*["']?([^"'\r\n]+)["']?/m)?.[1]?.trim();
  if (!raw) return true;
  const retryAt = Date.parse(raw);
  return !Number.isFinite(retryAt) || retryAt <= now;
}

/** Inserisce `exo-answered` nel frontmatter (testo grezzo, wikilink-safe). */
function stampAnswered(note: ParsedNote, iso: string): string {
  return patchFrontmatter(note.fm + note.body, { "exo-answered": iso }, ["exo-attempts", "exo-retry-after"]);
}

export function stampQueueFailure(note: ParsedNote, attempt: number, now: number): string {
  const exhausted = attempt >= MAX_ATTEMPTS;
  const changes: Record<string, unknown> = { "exo-attempts": attempt };
  if (exhausted) changes["exo-failed"] = new Date(now).toISOString();
  else changes["exo-retry-after"] = new Date(now + RETRY_BASE_MS * 2 ** (attempt - 1)).toISOString();
  return patchFrontmatter(
    note.fm + queueRequestBody(note.body),
    changes,
    exhausted ? ["exo-retry-after"] : []
  );
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
    if (!isQueueRetryDue(content)) continue;

    const { fm, body } = parseNote(content);
    const prompt = queueRequestBody(body);
    const result = await runHeadlessPlaybook(app, settings, prompt);
    const iso = new Date().toISOString().slice(0, 16).replace("T", " ");

    const previousAttempts = Number(fm.match(/^exo-attempts:\s*(\d+)/m)?.[1] ?? 0) || 0;
    const attempt = previousAttempts + 1;
    const heading = result.ok
      ? "## Risposta (Exo · read-only)"
      : `## Errore (Exo · tentativo ${attempt}/${MAX_ATTEMPTS})`;
    const answer = result.ok
      ? result.output || "*(risposta vuota)*"
      : `${result.error ?? "errore sconosciuto"}\n\n${result.output}`.trim();
    const base = result.ok
      ? stampAnswered({ fm, body: prompt }, iso)
      : stampQueueFailure({ fm, body: prompt }, attempt, Date.now());
    const next = `${base.replace(/\s*$/, "")}\n\n${heading}\n\n${answer}\n`;

    // Rileggi prima di scrivere: se la nota è cambiata durante l'esecuzione
    // (edit dal telefono mid-run), non sovrascrivere — la riprende il
    // prossimo drain sulla versione nuova.
    const latest = await app.vault.read(file);
    if (latest !== content) continue;
    await app.vault.modify(file, next);
    done++;
    if (result.ok) new Notice(`Exo queue: risposta pronta → ${file.basename}`);
    else if (attempt < MAX_ATTEMPTS) new Notice(`Exo queue: tentativo ${attempt} fallito — riprovo più tardi.`);
    else new Notice(`Exo queue: ${file.basename} fallita dopo ${MAX_ATTEMPTS} tentativi.`);
  }
  return done;
}
