# Plugin-level orchestration — report

**Data:** 2026-08-10 · **Branch:** `main` · **Commit:** `1eecb44`, `650c4f5`, `334f183`

## Il problema

Il driver dell'orchestrazione veniva costruito in `BoardView.onOpen` e fermato in
`onClose`. Con il tab della board chiuso non girava niente: `spawn_task`
accettava la delega, scriveva la riga `queued` in `tasks.md`, prometteva
all'agente che il lavoro sarebbe partito e avrebbe riportato, e il figlio non
partiva mai. La delega era, di fatto, presa di appunti.

## Cosa è cambiato

### 1. Il driver appartiene al plugin

`OrchestrationRuntime` (`src/obsidian/orchestration.ts`) possiede driver, ledger
watch e listener del vault. Parte a `onLayoutReady` quando
`orchestrationEnabled` è on, segue il toggle delle settings a caldo senza
reload, e si ferma pulito su `onunload`.

Perché a layout-ready e non prima: `startTaskConversation` crea la leaf laterale
di Exo se non esiste, e farlo durante il restore del workspace di Obsidian è una
gara che non conviene correre.

Il modulo non importa `obsidian`: tutto ciò che è workspace- o vault-shaped
arriva iniettato da `orchestration-wiring.ts`. Il lifecycle intero è così
testabile con fake, come già lo era il driver.

`main.ts` era esattamente al suo tetto (3480 righe), quindi tiene solo il campo
`orchestration`, tre chiamate e l'import; è tornato a 3480 esatte compattando
`syncBoardRibbon` e la doc ora obsoleta di `applyOrchestrationToggle`.

### 2. La board diventa un renderer

`BoardView` si attacca al runtime (`onTasks` + `snapshot()`), dipinge e instrada
i gesti (`run`/`move`/`markDone`/`archive`) al driver del plugin. `onClose`
stacca il renderer e nient'altro. Aprire e chiudere ripetutamente non
doppia-sottoscrive niente: `start()` è idempotente e concorrenza-safe.

### 3. "Nessun host" ≠ "spawn fallito"

Questa era la parte pericolosa. `startTaskConversation` risolve a `""` quando
non c'è una ChatView, e `runEffect` leggeva qualsiasi convo id falsy come
FALLIMENTO: `needs-input`, badge di errore, Notice, e un child report `error` al
genitore. Con il driver che parte al load del plugin quel ramo diventava la
norma, non l'eccezione: all'avvio di Obsidian ogni task in coda sarebbe stato
bruciato in un fallimento falso.

Ora il driver chiede `canSpawn()` **prima** di promuovere. Se la risposta è no,
`withholdSpawns` (puro, in `core/orchestrator.ts`) riavvolge la promozione prima
che venga persistita: il task resta `queued`, non occupa slot, non prende badge,
non manda report, non alza Notice. `onSpawnHostMissing` dice alla shell di armare
il retry. Un fallimento vero, con un host presente, si comporta esattamente come
prima.

Il gate passa da `reduceGated`, usato da **tutti e tre** i punti in cui gira lo
scheduler (evento dispatchato, archive che libera uno slot, spawn fallito che ne
rioccupa uno): un gate su uno solo avrebbe comunque bruciato task.

### 4. Il retry è event-driven, con un backstop dichiarato

`canSpawn()` ha tre stati, non due:

| Stato | Risposta | Perché |
|---|---|---|
| ChatView montata | sì | c'è dove mettere la conversazione |
| Nessuna leaf | sì | `startTaskConversation` la crea on demand, come ha sempre fatto |
| Leaf esistente ma **deferred** | **no** | `convoBridge.chatView()` torna null e lancia `loadIfDeferred()`; spawnare ora prende `""` e brucia il task |

Il retry si aggancia a `layout-change` e `active-leaf-change`. Il poll da 1s
esiste **solo** per il terzo caso: una view deferred si materializza via
`loadIfDeferred()`, non per un gesto dell'utente, quindi non c'è un evento
affidabile su cui appendersi. È armato solo mentre qualcosa aspetta e si spegne
— insieme alla sottoscrizione al workspace — appena un host compare. Con il poll
attivo, chiamare `canSpawn()` è anche ciò che *causa* la materializzazione.

### 5. Race di teardown chiusa

Un `stop()` che atterrava dentro il `store.load()` del boot lasciava il boot
riprendere e sottoscrivere un driver di cui nessuno teneva più il manico. Un
contatore `generation`, bumpato da ogni `stop()`, lo fa abbandonare.

## Verifica

```
pnpm test       → 138 files, 2213 tests, 0 failures
pnpm typecheck  → clean
pnpm lint       → 0 errors, 8 warnings (pre-esistenti)
src/main.ts     → 3480 righe (tetto 3480)
src/view.ts     → 6583 righe (tetto 6600)
```

### Test scritti rossi prima del fix

`tests/orchestrator-driver.test.ts` (4 nuovi) contro il codice pre-fix:

```
× withholds the promotion: the task stays queued, with no badge, no notice, no report
  → expected 'running' to be 'queued'
× consumes no concurrency slot while withheld
  → expected [...] to have a length of +0 but got 2
× tells the shell a host is missing so it can arm a retry
  → expected "spy" to be called at least once
```

`tests/fanout-wiring.test.ts`, blocco *orchestration ownership*, con
`src/main.ts` e `src/ui/board-view.ts` allo stato pre-fix:

```
× the plugin starts the runtime at layout-ready and stops it on unload
  → expected 'this.app.workspace.onLayoutReady(...)' to contain 'this.orchestration.sync()'
× a settings toggle starts or stops it live, with no reload
× the board never constructs a driver or a ledger watch of its own
  → expected board source not to contain 'new OrchestratorDriver'
× closing the board stops nothing
  → expected 'async onClose()' not to contain 'driver'
× opening the board attaches to the running runtime instead of starting one
```

E la race di teardown, con `orchestration.ts` stashato al primo stato:

```
× abandons a driver whose runtime was stopped mid-load (no orphan subscription)
  → expected 1 to be +0
```

`tests/orchestration-runtime.test.ts` è nuovo (18 test): gira senza board, non
parte a flag off, `sync()` a caldo, doppio start, stop senza timer né listener
residui, renderer che si stacca senza fermare niente, renderer che throwa,
i cinque casi "no host", reload da modifica esterna del ledger, teardown race.

## Verifica nel vault live

`pnpm build` → deploy automatico · `obsidian-cli plugin:reload id=exo` ·
`obsidian-cli dev:errors` → *No errors captured*.

Prova reale, **con la board chiusa** (`exo-board` leaves = 0):

1. Backup del ledger in `/tmp/exo-tasks-backup.md`.
2. Append esterno di un task `queued` con `parent: c200`.
3. Dopo pochi secondi, letto via `obsidian-cli eval`:

```json
{"board":0,"running":true,
 "probe":{"id":"task-1786000000001","status":"running","convo":"c202","parent":"c200"}}
```

4. A turno finito, il ledger su disco riporta `status: review`, `convo: c202`, e
   il genitore ha il report in coda:

```json
{"child":{"id":"c202","title":"OK","parentConvoId":"c200","msgs":2},
 "parentPendingReports":[{"taskId":"task-1786000000001","outcome":"done","excerpt":"OK"}]}
```

Il giro completo — append esterno → promozione → spawn parentato → turno →
`review` → report al genitore — con zero tab della board aperti. Prima di questa
modifica, nulla di tutto ciò sarebbe successo.

**Cleanup eseguito:** ledger ripristinato dal backup (`diff` vuoto), conversazione
`c202` cancellata (58 conversazioni, come prima), `pendingChildReports` di `c200`
svuotato, `dev:errors` pulito.

> Nota emersa durante la prova: `parseTasksFile` accetta solo header
> `## task-<cifre>` (`HEADER = /^##\s+(task-\d+)\s*$/`) e scarta gli altri **senza
> warning**. Un id non numerico sparisce in silenzio. Fuori scope qui, ma è un
> buco: vale un warning.
