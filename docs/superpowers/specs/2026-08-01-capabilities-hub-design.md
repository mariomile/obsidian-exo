# Capabilities Hub — design

**Date:** 2026-08-01 · **Status:** shipped (steps 1–7) · **Supersedes the pane half of** `2026-07-21-connections-marketplace-design.md`

## Cosa & perché

Le superfici di capability di Exo erano tre, sovrapposte e incoerenti:

1. **Capabilities overlay** (`ui/capabilities.ts`, 617 righe) — griglia di chip read-only dentro la chat: Session, Memory, Autonomy, System, Playbooks, Commands, Agents, Skills, Hooks, Tools, MCP.
2. **Connections pane** (`ui/connections-view.ts`, 431 righe) — ItemView vero, 2 tab (MCP · Skills), righe gestibili con azioni inline.
3. **Automations modal** (`ui/automations-modal.ts`, 478 righe) — righe a chip + riga Daily Pulse hardcoded + review dei write run.

MCP e Skills comparivano in due posti (chip read-only da una parte, righe gestibili dall'altra); Automations si nascondeva in un modal; il refresh era manuale in una superficie e automatico nell'altra. Obiettivo: **un solo hub**, dove vedere una cosa e agirci sopra sono lo stesso gesto — il modello Claude app / Codex app.

## Il valore: prima vs dopo

**Prima:** per capire quali MCP erano connessi guardavi l'overlay in chat; per riconnetterne uno aprivi il pane Connections; per vedere quando gira una automation aprivi un modal da un bottone in settings. Tre mappe mentali diverse per lo stesso dominio.

**Dopo:** un pane con sei tab. Le chip read-only sono diventate righe con le azioni accanto.

**Esempio tangibile:**
- *Prima:* vedo "notion · needs-auth" come chip grigia nell'overlay → chiudo l'overlay → Apps menu → Connections → tab MCP → cerco la riga → Re-auth.
- *Dopo:* apro Capabilities → tab MCP → la riga dice `needs-auth` e ha il bottone Re-auth accanto.

## Architettura

```
                    ┌──────────────────────────────┐
   chat header ────►│ session-card.ts (slim)       │
   (blocks icon)    │  provider/model/effort chips │
                    │  capsSummary() counts        │
                    │  [Open Capabilities] ────────┼──┐
                    └──────────────────────────────┘  │
                                                      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ ui/hub/hub-view.ts   ItemView "exo-connections"             │
  │  TabDef[] registry · data-tab pills · showTab() · refresh() │
  │  HubTabContext { app, plugin, rerender, base }              │
  ├─────────────────────────────────────────────────────────────┤
  │ tab-overview · tab-skills · tab-mcp                         │
  │ tab-playbooks · tab-automations · tab-memory                │
  └───────────┬────────────────────────────┬────────────────────┘
              │ pure                       │ impure
              ▼                            ▼
   core/hub-sections.ts            core/capability-scan.ts
   core/actions-hub.ts             (fs scans, adapter reads)
   core/automations.ts
```

Il flusso dati di ogni tab: **live caps prima, disk scan come fallback**. Lo snapshot `system/init` della CLI è la verità su cosa una sessione ha davvero caricato; gli scanner filesystem coprono il buco prima del primo spawn e su Codex (che non emette caps).

## Cosa vede l'utente

```
┌─ Capabilities ──────────────────────────────────────────────┐
│ [Overview] [Skills] [MCP] [Playbooks] [Automations] [Memory]│  ↻
├─────────────────────────────────────────────────────────────┤
│ CONNECTED                                              3    │
│ notion        vault    npx @notionhq/…    ● active   Edit … │
│ supabase      vault    https://mcp.su…    ● needs-auth  Re-auth │
│ IMPORTABLE                                             2    │
│ granola       Codex    stdio granola-mcp        Connect     │
└─────────────────────────────────────────────────────────────┘
```

| Tab | Cosa gestisce |
|---|---|
| Overview | sessione + system status, azioni Exo Queue, stato "no session yet" |
| Skills | marketplace skill (import/remove) + sezioni chip Commands, Sub-agents, Hooks, Tools |
| MCP | add / edit / enable / disable / remove / reconnect / re-auth |
| Playbooks | custom prompt, badge schedule, Run now read-only |
| Automations | run schedulati, Daily Pulse, write run ripristinabili |
| Memory | dream pass, store, open-loops, file di vault memory |

## Decisioni di architettura

- **Il view-type resta `exo-connections`.** Obsidian persiste la stringa in `workspace.json` senza alias: rinominarla romperebbe ogni layout salvato. Cambia solo il display text ("Capabilities").
- **Righe + azioni inline, non card con click-through.** Vedere e agire sono lo stesso gesto; è anche il pattern già collaudato del pane Connections.
- **Un renderer per tab, non un `render()` monolitico.** Il vecchio `render()` era già un if/else lungo a 2 tab; a 6 sarebbe stato ingestibile.
- **Le pill sono keyed su `data-tab`.** Il toggle a indice del vecchio pane (`(i === 0) === (tab === "mcp")`) si rompe oltre due tab.
- **Il cambio tab svuota l'host.** I tab mischiano strategie di render (keyed reconcile vs full render): senza `empty()` i figli non-keyed di un tab sopravvivrebbero al successivo.
- **Automations resta a full re-render.** Le righe mutano `settings.automations` in place e i popover tengono stato transitorio: una `sig` dovrebbe codificare tutto per zero guadagno a questa dimensione di lista.
- **Niente glifi testuali.** `⚠`/`⏱`/`▸`/`⚙` diventano `setIcon` lucide; il Restore armato passa da `mod-warning` a `mva-btn-danger`.

## Verifica

- 7 commit indipendenti, ognuno con `pnpm lint && pnpm test && pnpm build` verde.
- Suite finale: **112 file, 1474 test passati** (+15 nuovi: `hub-sections`, `formatDueIn`, `playbookScheduleLabel`, `dailyPulseMetaLabel`, `capsSummary`).
- `style-contract.test.ts` verde dopo le aggiunte CSS (nessun hex/ms raw, nessun `!important`).
- Verifica manuale: palette, tile Cockpit, bottone settings e URI `obsidian://exo-daily-pulse?target=automation` atterrano tutti sul tab Automations.

## Fuori scope (v1)

- **Insert nel composer dalle chip** (`/cmd`, `@agent`): l'hub vive in un leaf separato, servirebbe `ChatView.insertIntoComposer`. Rimandato.
- **Search/filter** nelle liste: mitigato dal collasso "N già in Exo".
- **Gestione da chat** (tool agent-callable per MCP/skill/automation): è il capitolo successivo — vedi il design dell'agentic capability layer.
