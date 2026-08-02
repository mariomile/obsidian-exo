# Source detail accordion — Craft Agents parity for MCP & Skills

**Date:** 2026-08-02 · **Status:** approved, pending implementation · **Builds on:** `2026-08-01-capabilities-hub-design.md`

## Cosa & perché

Il tab MCP dell'hub mostra oggi una riga per server: nome, origine, descrizione, stato, azioni. Craft Agents (screenshot di riferimento: la source Gmail) mostra molto di più per ogni source — Connection (come si connette), Permissions (endpoint/pattern consentiti), Documentation (markdown reso, con titoli e bullet) — in un pannello di dettaglio. L'hub aveva già i pezzi (config, note per-server da `.claude/mcp/<name>.md`, regole di permission) ma non un posto dove vederli insieme.

Il tab Skills ha lo stesso problema al contrario: una lista piatta di skill importabili raggruppate per origine, senza modo di comprimerla — con decine di progetti diventa uno scroll infinito.

## Il valore: prima vs dopo

**Prima:** per sapere se `mcp__notion__create_pages` è autorizzato o chiede conferma ogni volta, bisognava aprire settings e leggere le regole a mano contro il nome del tool. Per sapere a cosa serve `notion`, bisognava aprire la nota `.claude/mcp/notion.md` in un'altra tab.

**Dopo:** click sul nome del server → si apre sotto la riga stessa con tutto — connessione, ogni tool esposto con il suo stato di permission, la documentazione resa come vero markdown (non testo appiattito).

**Esempio tangibile:**
- *Prima:* "posso usare `create_pages` senza che mi chieda conferma?" → apri settings → leggi le regole → confronti a mano.
- *Dopo:* apri l'accordion di notion → la riga `create_pages` dice `asks each time` esplicitamente.

## Architettura

### Stato "espanso" — la novità strutturale

I tab sono funzioni pure re-invocate a ogni render (`render<Tab>Tab(host, ctx)`), senza stato proprio. Un accordion deve ricordare quali righe sono aperte tra un render e l'altro (es. dopo che un'azione chiama `ctx.rerender()`). Lo stato vive nella `HubView` (UI, non dato persistente — si resetta alla chiusura del pane) ed è esposto via `HubTabContext`:

```ts
interface HubTabContext {
  // ... esistente
  expanded(key: string): boolean;
  toggleExpanded(key: string): void;
}
```

La `sig` di ogni riga in `reconcileList` include lo stato open/closed, così il diff esistente ricostruisce la riga solo quando serve — nessun nuovo meccanismo di reconciliation.

### MCP tab — accordion a 3 sezioni

Click sul nome del server (stesso idioma già in uso nel run-log di Automations: label cliccabile, azioni separate — niente `stopPropagation` da inventare) espande:

```
notion        vault    ● active                    Edit · Disable · Remove
▾
  Connection
    transport: stdio · command: npx @notionhq/notion-mcp-server
  Permissions
    search               auto-allowed   (mcp__notion__*)
    create_pages          asks each time
    query_data_sources    asks each time
  Documentation
  ┌─────────────────────────────────┐
  │ # notion                        │
  │ ## Scope                        │
  │ • Read the roadmap DB           │  ← reso vero (MarkdownRenderer),
  │ • Search meeting notes          │     capped + sfumato in fondo
  └─────────────────────────────────┘
                              [Edit notes]
```

- **Connection**: transport/command-o-url/args dal config del server (`summarizeServer` in `core/mcp-config.ts` già li produce).
- **Permissions**: ogni tool del server da `caps.tools` filtrato su `mcp__<name>__*` quando la sessione è viva; senza sessione, placeholder "compare dopo la connessione". Stato per riga via `matchPermRule` (già esiste, nessun nuovo core) contro `permDenyRules`/`permAllowRules`: denied / auto-allowed / asks each time.
- **Documentation**: **markdown reso davvero**, non testo appiattito. Riuso l'idioma già in `view.ts:4383` (le artifact card in chat): `summarizeMcpDoc` toglie prima frontmatter e commenti (altrimenti `MarkdownRenderer` li renderebbe come testo letterale), poi `MarkdownRenderer.render()` di Obsidian produce titoli/bullet veri, con lo stesso trattamento capped+fade (`.mva-artifact-fade`) delle card esistenti. `hasMcpDocContent` decide se mostrare il preview o lo stato vuoto "nessuna nota — Add notes".

Il bottone "Notes" e il badge di regola che oggi vivono sulla riga collassata si spostano dentro l'accordion (niente doppioni). Sulla riga collassata resta solo un'icona muta se il server ha note o una regola attiva — un colpo d'occhio, non il dettaglio.

### Skills tab — accordion per origine

Stessa meccanica di stato. La sezione "in questo vault" diventa un accordion proprio (aperto di default — sono le skill che l'utente già usa), ogni origine importabile (Codex, ogni cartella progetto) è un accordion chiuso di default con conteggio in testata. Sostituisce la lista piatta di oggi. Nessun nuovo asse Claude/Codex: le skill sono file `.md` che qualunque sessione può leggere, non sono legate a un provider — l'origine "Codex" resta semplicemente una delle tante origini, come già modellato in `skillSections`.

## Cosa NON cambia

- Il pattern "righe con azioni inline, non card con click-through" resta intatto — l'accordion *è* la riga che si espande, non una navigazione altrove.
- Nessun bottone per allentare i permessi dall'hub: la sezione Permissions è sola lettura, cambiare una regola resta un atto deliberato in settings.
- `core/hub-sections.ts`, `core/mcp-docs.ts`, `core/permissions.ts` (incluso `matchPermRule`/`matchToolName`) sono già pronti — questa feature è quasi tutta UI più un piccolo helper di formattazione per lo stato-permesso-per-tool.

## Fuori scope

- Editing della documentazione inline nell'accordion (resta: apri la nota vera in una tab).
- Un secondo pannello master-detail in stile Craft a schermo intero — l'hub resta un pane singolo dentro Obsidian.

## Aggiunte dello stesso giorno (2026-08-02, seconda metà)

Su richiesta di Mario, oltre all'accordion:

- **Composer-insert dai chip** — `Composer.insertText` (append + focus) delegato da `ChatView.insertIntoComposer`, con wrapper a livello plugin `ExoPlugin.insertIntoComposer` sul modello di `revealConversation`. I chip Commands (`/`) e Sub-agents (`@`) nel tab Skills diventano cliccabili: click → rivela la chat, inserisce `/cmd `/`@agent ` nella conversazione attiva. Hooks/Tools restano solo informativi.
- **Search/filter** su MCP e Skills — box di ricerca stable-keyed in `reconcileList` (mai ricostruito mentre l'utente digita, il focus non si perde), `matchesQuery` in `core/hub-sections.ts`, debounce 150ms prima del re-render (entrambi i tab rileggono dati da disco a ogni render). Su Skills i gruppi per origine con match si aprono automaticamente durante la ricerca (idioma "VS Code file-tree search") **senza toccare** lo stato di accordion persistito — cancellare la ricerca ripristina esattamente ciò che l'utente aveva impostato a mano.
- **Rimossa la session card in chat** — il mini-pannello con i chip provider/model/effort duplicava l'Overview dell'hub e Mario non lo usava. Il bottone Capabilities nell'header ora apre l'hub direttamente (`plugin.activateHub()`), eliminando `ui/session-card.ts` e tutto il plumbing `capsEl` in `view.ts`.

## Verifica

- Nuovo test puro per l'helper di stato-permesso-per-tool (`core/permissions.ts` o vicino).
- `pnpm lint && pnpm test && pnpm build` verde a ogni commit.
- Verifica manuale: apri/chiudi accordion MCP e Skills, conferma che lo stato espanso sopravviva a un'azione che richiama `rerender()` (es. Reconnect), conferma che il markdown delle note sia reso con titoli/bullet veri.

## Scoperto durante l'implementazione

Aprendo la sezione Permissions su un connector claude.ai reale (Craft), zero tool comparivano nonostante il server ne esponga tre. Causa: `scanLiveCaps` normalizza il nome grezzo (`"claude.ai Craft"`) nel nome amichevole mostrato in riga (`"Craft"`), ma i tool live in `caps.tools` usano un prefisso derivato dal nome GREZZO sanificato (`mcp__claude_ai_Craft__…`), non dal nome amichevole. Il probe ingenuo `mcp__${name}__` — usato anche dal badge di regola esistente — non ha mai fatto match su nessun connector. Fix: `toolNamePrefix()` in `core/connections-scan.ts` ricostruisce il prefisso grezzo da `source`+`name`, con test contro i nomi reali osservati. Non è un contratto documentato dell'SDK — è stato dedotto dai dati — quindi un eventuale mismatch futuro degrada a "nessun tool elencato", mai a un permesso sbagliato.
