# Background tasks — inline enumerable list in the chat

**Date:** 2026-07-22
**Status:** Design approved — ready for implementation plan
**Related:** `docs/plans/2026-07-21-session-cockpit.md` (keep-alive deferral), `src/core/workflow-progress.ts`

---

## Problema

Oggi, quando Exo ha del lavoro "in background" (un subagent `Task`/`Agent` in volo, un `Bash` con `run_in_background`, o gli agenti di un `Workflow`), l'unica affordance è il chip `.mva-agents` sopra la composer, che mostra **solo un contatore** — "2 agents running" (`view.ts:4324-4335`). Non c'è modo, restando nella chat, di sapere **quali** cose stanno girando e cosa fanno. Il pannello Session Cockpit esiste ma è un posto separato, e comunque non risolve la visibilità del lavoro in corso.

Lo scenario che ha fatto emergere il bisogno: un `Agent` lanciato con `run_in_background` (es. `tldraw-offline` che "crea il canvas in background") — il messaggio dell'assistente finisce, il turno chiude, e con esso sparisce anche il chip, **mentre il processo è ancora vivo**.

## Obiettivo

Rendere il **flusso della chat stesso** la fonte di verità su cosa sta girando: il chip esistente diventa **espandibile** in una lista enumerabile dei task attivi di quella chat, ognuno con label + stato, cliccabile per saltare alla sua card nel thread. La lista **sopravvive alla fine del turno** (keep-alive Livello 1).

## Non-goals

- **Cross-chat / pannello globale.** Il chip resta strettamente locale alla chat aperta (invariante attuale, `view.ts:4322`). Un pannello che aggrega i task di tutte le chat è il lavoro del Session Cockpit, non di questo spec.
- **Keep-alive Livello 2 (event pump di sessione).** Aggiornamenti di stato *live* a turno chiuso (un listener persistente per-sessione, disaccoppiato dal loop del turno) restano fuori scope — è il refactor che il Cockpit ha già rimandato (fuso DOM/session/turn). Questo spec fa il Livello 1 + riconciliazione, che è il gradino esatto verso il Livello 2.
- **Output live inline nella riga.** Cliccando una riga si salta alla card esistente; non si costruisce una nuova UI di output dentro il popover.

## Decisioni (dal brainstorming)

| Tema | Scelta |
|---|---|
| Forma & posizione | Chip espandibile sopra la composer (estende `.mva-agents`) |
| Cosa elencare | Subagent (Task/Agent) + Bash background + agenti di Workflow — tutto ciò che è vivo, senza filtro |
| Interazione riga | Click → scroll + flash alla card corrispondente nel thread |
| Approccio dati | A — una mappa arricchita colocata, registry-ready (non un modulo registry a sé) |
| Keep-alive | Livello 1 (stato su `Convo`, sopravvive al turno) + riconciliazione allo stream |

---

## 1. Modello dati

Una sola mappa arricchita, **spostata da `ctx` (per-turno) a `Convo` (per-conversazione, vive finché il leaf è aperto)** — questo è il keep-alive Livello 1.

```ts
type LiveTaskKind = "subagent" | "bash" | "workflow";
type LiveTaskStatus = "running" | "done" | "error" | "stopped";

interface LiveTask {
  id: string;              // tool-call id (subagent/bash) o toolUseId (workflow)
  kind: LiveTaskKind;
  label: string;           // "tldraw-offline" · il comando bash · "deep-research · phase Verify"
  status: LiveTaskStatus;
  cardEl: HTMLElement;      // bersaglio dello scroll-to (card del subagent/bash/Workflow)
  startedAt: number;
  doneAt?: number;         // per il fade-out a ~2s dopo done/error
}
```

Vive su `Convo`:

```ts
// su Convo (non su AssistantCtx)
liveTasks: Map<string, LiveTask>;
```

`AssistantCtx` è raggiungibile da `ctx.convo` (`view.ts:308`), quindi i siti di registrazione scrivono in `ctx.convo.liveTasks`.

**`agentCount` diventa** `c.liveTasks.size` (letto dal `Convo`, non più da `c.currentCtx`) → il numero sul chip coincide sempre con la lunghezza della lista, **e non si azzera a fine turno**.

> Nota: `runningTasks` (Set) e `bgTasks` (Map con `cardEl`/`badgeEl`) restano dove sono per la loro logica attuale (nesting, badge, link BashOutput). `liveTasks` è la proiezione arricchita che il chip consuma; i tre siti la popolano in parallelo. Questo evita di rifare un `Set` in `Map` e tiene il diff piccolo.

## 2. Siti di registrazione

Tre punti che già esistono, ognuno aggiunge/aggiorna una entry in `ctx.convo.liveTasks`:

- **Subagent** — in `registerTaskCard` (`view.ts:3692`): entry `kind:"subagent"`, `label` = nome del subagent (dal `toolMeta`/target del Task), `cardEl` = `ctx.cards.get(id)?.card`. Rimozione/transizione a `done` dove oggi `runningTasks.delete` (`view.ts:4739`).
- **Bash background** — in `trackBackgroundTask` (`view.ts:3649`): entry `kind:"bash"`, riusa `cardEl` già catturato, `label` = comando. `badgeEl` già passa a `running`/`stopped` → specchia lo `status` nella entry.
- **Workflow** — unico cambio strutturale: `workflowRuns` (oggi locale a `runTurn`, `view.ts:4623`) va **sollevato su `ctx`/`Convo`** così gli agenti running entrano nella lista e nel conteggio. `label` da `summarizeWorkflowRun(run).label`; `cardEl` = card del tool Workflow (via `refs.wfEl`). Quando il run è `completed`/`failed`, una riga sola "workflow done/failed".

## 3. UI — chip espandibile

Il chip `.mva-agents` (`view.ts:479`, in `listWrap` sopra la composer) diventa un toggle:

```
  ┌────────────────────────────────┐
  │ ◐ tldraw-offline    · running  │ ← click → scroll+flash alla card
  │ ◐ npm run build     · running  │
  │ ✓ verify agent      · done     │
  └────────────────────────────────┘
  ◐ 3 agents running            ▲     ← click chip = apri/chiudi
 ┌──────────────────────────────────┐
 │ Message the agent...             │
```

- Popover ancorato al chip, **apre verso l'alto**. Chiude su: secondo click, click fuori, `Esc`.
- Riga: **dot di stato** (riuso i colori di `.mva-subagent-dot` → `is-ok`/`is-error`), **label**, **status + elapsed** (da `startedAt`).
- Icona chip: spinner `loader` finché c'è ≥1 `running`; se tutto è `done`/`error`, icona statica.
- Ogni riga ha un **dismiss `×`** (escape hatch per righe eventualmente bloccate su running — vedi §5 riconciliazione).

## 4. Interazione — riga → card

Click su una riga:
1. `task.cardEl.scrollIntoView({ block: "center" })`
2. classe transitoria `.mva-flash` sulla card (~1s, poi rimossa) per evidenziare quale.
3. chiude il popover.

Per i workflow, `cardEl` è la card del tool Workflow (il singolo agente non ha una card propria) — comportamento onesto e sufficiente.

## 5. Lifecycle, keep-alive Livello 1 & riconciliazione

**Sopravvivenza al turno:** poiché `liveTasks` vive su `Convo`, la lista **non sparisce** a fine turno. Copre lo scenario dello screenshot.

**Il limite del Livello 1:** il *produttore* degli aggiornamenti di stato è lo stream del turno (`onEvent`, `view.ts:4625`). A turno chiuso non arrivano eventi → una entry potrebbe restare `running` finché non c'è di nuovo uno stream attivo. Mitigazioni:

- **Transizione visibile a done:** su `tool-call-result` la riga passa a `done`/`error`, resta ~2s (barrata/fade), poi esce. Non "sparisce e basta".
- **Riconciliazione allo stream successivo:** all'inizio di `runTurn` (nuovo stream — es. quello che una task-notification riapre), fai uno **sweep** di `Convo.liveTasks`: le completion arrivate come `tool-call-result` su questo stream aggiornano/rimuovono le entry (la logica di `view.ts:4739` continua a funzionare, ora puntando a `Convo.liveTasks`). Entry palesemente orfane (card non più nel DOM) vengono rimosse.
- **Dismiss manuale:** il `×` per-riga permette a Mario di togliere una entry rimasta stuck senza aspettare la riconciliazione.

**Empty state:** zero task → chip `is-hidden` (comportamento attuale). Popover aperto che si svuota → si chiude da solo.

**Multi-chat:** invariato — ogni chat mostra solo i propri; le altre riportano il conteggio sulla loro tab. Nessun leak.

## 6. Edge cases

- **Card scrollata via / fuori vista:** `scrollIntoView({ block:"center" })` + flash.
- **Card rimossa (turno vecchio ripulito):** la entry non dovrebbe esistere; lo sweep di riconciliazione la toglie se sopravvive orfana.
- **Workflow senza agenti ancora emessi:** il run è tracciato ma `agents` vuota → mostra "workflow · phase X" come singola riga finché il roster non popola.
- **Stato `stopped` (KillShell):** `badgeEl` → `stopped`, entry `status:"stopped"`, stessa regola di fade dei `done`.

## 7. Verifica

- **Typecheck** pulito (`npm run typecheck` o equivalente del repo).
- **Test unit** sul reducer se tocco `workflow-progress.ts`; test su `agentCount`/proiezione `liveTasks` se estraibile in funzione pura.
- **Manuale in-vault** (build → deploy al vault via `.obsidian-plugin-dir`, poi `plugin:reload`):
  1. Lancia un subagent lungo → chip mostra "1 agent running", apri → riga con label + running.
  2. Lancia un `Bash run_in_background` in parallelo → seconda riga.
  3. Click su una riga → scroll + flash alla card giusta.
  4. Fine turno con subagent ancora vivo → **la lista NON sparisce** (keep-alive L1).
  5. Completamento → riga passa a done, poi esce dopo ~2s.
  6. Dismiss `×` su una riga stuck → esce subito.

## File toccati (stima)

- `src/view.ts` — tipo `LiveTask`; `liveTasks` su `Convo`; popolamento in `registerTaskCard` / `trackBackgroundTask`; sollevamento `workflowRuns` su ctx/Convo; `agentCount` da `Convo.liveTasks`; chip toggle + rendering popover + click→scroll/flash; sweep di riconciliazione in `runTurn`.
- `styles.css` — stile popover (`.mva-agents-list`?), riga, dot riuso, `.mva-flash`, dismiss `×`.
- `src/core/workflow-progress.ts` — eventuale export della proiezione a `LiveTask` (se estraggo la logica).
- Test — reducer / proiezione pura se estraibile.

## Registry-ready

La `shape LiveTask` e il suo popolamento da tre siti sono deliberatamente la base del futuro registry cross-chat del Cockpit (Livello 2): il salto sarà spostare `liveTasks` da `Convo` a uno store condiviso + un event pump di sessione, un refactor meccanico — non una riscrittura.
