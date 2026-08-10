# Sidebar chats — livello visivo: gruppi collassabili e status dot

**Data:** 2026-08-10 · **Commit:** `2135518` (core + settings), `cb5f97f` (view + CSS)
**Verifica:** 137 file / 2187 test, 0 fail · `pnpm typecheck` pulito · `pnpm lint` 0 errori (8 warning preesistenti) · `src/view.ts` **non toccato**, resta a 6577 righe (tetto 6600)

Continua `2026-08-10-sidebar-state-groups-report.md`: quello ha portato il modello
(`ChatSection` / `ChatListVM`), questo porta rendering, interazione e CSS. Il
view-model non è stato modificato.

---

## 1. Gruppi collassabili

### Dove vive lo stato

`settings.chatsCollapsed: string[]` — accanto a `chatsMode`, che è la stessa
categoria di cosa: una preferenza di vista piccola e durevole che il pannello
rilegge a ogni paint. Persiste in `data.json` del plugin via `saveSettings()`,
scritto **sul gesto** e non a un save successivo: lo scopo dello stato è
sopravvivere al reload, e un crash fra toggle e save lo butterebbe via in
silenzio.

Chiavi: `ChatSectionKey`, **mai label**. Una sezione keyata sul testo a schermo
perde la scelta dell'utente il giorno in cui "Settled" viene riscritto. Assente
= espanso, quindi zero migrazione: un'installazione esistente apre esattamente
come prima.

Nessuna potatura dello stato: le chiavi possibili sono un insieme chiuso di 11
(5 stato + `related` + 5 `day:`), quindi non c'è accumulo.

### Logica pura, fuori dalla view

`src/core/chat-list-state.ts` (~75 righe) + `tests/chat-list-state.test.ts`
(13 test):

- `isSectionCollapsed(collapsed, key)` — assente = espanso
- `toggleSectionCollapsed(collapsed, key)` — ritorna una **nuova** lista (il
  chiamante persiste il risultato; mutare in place lascerebbe la memoria avanti
  al disco appena un save fallisce)
- `chatDot(row)` — quale dei tre marker, con la precedenza

`chat-list-view.ts` non contiene nessuna di queste regole: chiama e dipinge.

### Interazione

- **Target = header intero**, non il chevron. Un glifo da 12px è una cosa che
  si manca.
- **`div` con `role="button"`** via `clickable()` (`ui/dom.ts`): tabIndex 0,
  Enter e Space, ring di focus globale ereditato. Mai `<button>`: su un button
  vero `button:not(.clickable-icon)` di app.css (0,1,1) batte una regola a
  classe singola (0,1,0) e porta via padding e background.
- **aria**: header `aria-expanded` + `aria-controls`, lista `role="region"` +
  `aria-labelledby`. Gli id sono **sluggati** (`day:This week` →
  `day-This-week`): è una section key legale e un id HTML illegale, e
  `aria-controls` è una *lista* separata da spazi — non sluggarlo avrebbe
  slegato la relazione senza un solo errore a console. Prefisso per-pannello
  (`exo-chats-<n>`) perché Obsidian ammette lo stesso view type in due leaf.
- **Conteggio solo da collassato.** È il motivo per cui collassare è sicuro: un
  header che nasconde le righe senza dire quante trasforma "metti via" in
  "dimentica". Da espanso le righe si vedono e il numero è rumore.

### Non litiga con la riconciliazione

La section element resta riusata per `data-section` come prima. Il collasso è
**stato sulla section**, non un rebuild: header, handler e wiring aria si
costruiscono una volta sola (`buildSection`), a ogni paint cambiano solo classe,
conteggio e `aria-expanded`. Una section collassata riconcilia a lista vuota —
tenere in DOM righe invisibili le lascerebbe nell'albero di accessibilità e
costerebbe un paint ogni 5s per roba che l'utente ha messo via.

Le righe collassate escono anche da `this.order`, quindi le frecce non ci
camminano dentro e Invio non può aprire una chat che non è a schermo.

---

## 2. Status dot al posto delle rail

Rimosse: `.mva-chats-row.is-active::before` (rail neutra "aperta come tab"),
`.mva-chats-row.is-rich.is-{running,needs-input,unseen}::after` (rail
accent/arancio/verde), più le classi di riga `is-running` e `is-unseen`, che
erano loro unici consumatori. `is-needs-input` resta: colora ancora il testo di
status. La rail neutra non è stata sostituita da niente — il gruppo `Open` lo
dice già.

```
  ●  Ricerca competitor        2m     ● pieno 6px  = running (pulse 2.6s)
  ○  Draft post                5m     ○ anello 8px = needs you
  ·   Analisi pricing           1h     · piccolo 4px = unseen
      Note vecchie             3g     (niente)      = a riposo
```

**Il gutter è sempre riservato.** `.mva-chats-dot` viene creato per *ogni* riga,
stato o meno, e il padding sinistro della riga è costante (12px → 20px = 6px di
inset + 10px di box + 4px d'aria). I titoli stanno su una sola verticale e la
lista non balla quando una chat parte o si ferma. Verificato a schermo: righe
con e senza dot hanno il titolo alla stessa x, sia rich sia compact.

**Forma prima del colore.** Pieno / anello / piccolo sono tre marchi diversi
anche in scala di grigi. Il colore rinforza e basta — nessun hex, solo
`var(--interactive-accent)`, `var(--color-orange)`, `var(--color-green)`.

**Allineamento verticale.** Riga rich (3 righe di testo): il box del dot è
`top: 7px; height: 1.5em`, cioè la line box del titolo — un dot centrato su una
card di tre righe galleggerebbe accanto al preview. Riga compact (1 riga):
`top: 0; bottom: 0`, centratura piena.

`pointer-events: none` sul dot: il target del click è la riga.

**Reduced motion.** Il blocco blanket di `.mva-root` già clampa ogni animazione
a un ciclo near-zero. Ribadito comunque con una regola dedicata
(`animation: none`) perché per *questo* elemento il movimento è il messaggio, e
lasciarlo a un clamp globale è il modo in cui il pulse ritorna il giorno in cui
qualcuno ri-scopa il blanket. Stesso blocco spegne le transizioni di chevron e
header.

---

## 3. Style contract

`src/style-contract.test.ts` verde senza waiver nuovi:

- **`!important`: zero aggiunti**, il ratchet resta a 6. Il ring di focus arriva
  dalla regola globale esistente (`:is([class^="mva-"]…) :is(button,
  .clickable-icon, [role="button"]):focus-visible`) — verificato con
  `matches()` sull'header vero: `true`.
- **Nessun hex, nessun `ms` grezzo, nessun `cubic-bezier` grezzo.** Il pulse è
  `2.6s ease-in-out`, le transizioni passano da `var(--mv-t, var(--mva-t))`.
- **Nessun `--mv-*` definito**: solo consumato, sempre con fallback inline al
  token Obsidian (`var(--mv-label-color, var(--text-faint))`,
  `var(--mv-r1, var(--mva-r1, 6px))`, `var(--mv-hairline, …)`).
- **Nessuna emoji**: chevron da lucide via `setIcon`, i tre marker sono pura
  geometria (`border-radius: 50%` su `::after`).
- `--mv-control-h` non toccato: l'altezza delle righe non cambia, cambia solo il
  padding sinistro.

---

## 4. Verifica live

`pnpm build` (deploy automatico nel vault) → `obsidian-cli plugin:reload
id=exo` → `obsidian-cli dev:errors`.

**Errori: nessuno nuovo.** L'unico in buffer è delle 15:20 (cinque ore prima
della build), un `listChatRows` pre-esistente su `allConvos()` con un elemento
undefined; non riprodotto in nessuno dei reload di questa sessione. Non
introdotto qui e non toccato.

### Cosa mostrano gli screenshot

| File | Cosa conferma |
|---|---|
| `/tmp/sidebar2.png` | Vista intera: header `OPEN` / `SETTLED` con chevron ruotato giù e hairline, **zero rail** a sinistra, dot verdi sulle righe unseen |
| `/tmp/dots_a.png` | Righe rich, i tre stati insieme: verde piccolo (unseen), pieno accent (running), anello arancio (needs-you) — tutti centrati sulla riga del titolo |
| `/tmp/dots_c.png` | Righe compact: stessi tre marker, centratura verticale piena, titoli su una sola verticale con e senza dot |
| `/tmp/coll_full.png` | `SETTLED 44` collassato: chevron ruotato a destra, conteggio accanto alla label, lista sparita, `OPEN` ancora aperto |
| `/tmp/light_c2.png` | Tema chiaro (`moonstone`): verde, nero pieno (accent `#222`), anello arancio — tutti leggibili su `#fff`. Tema ripristinato a `obsidian` subito dopo |

Probe funzionali via `obsidian-cli eval` sul pannello vero:

- toggle → `settings.chatsCollapsed = ["settled"]`, `aria-expanded="false"`,
  `textContent = "Settled44"`, `class` con `is-collapsed`
- `plugin:reload` → lo stato è ancora `["settled"]` e la sezione riapre
  collassata: **la persistenza regge il reload**
- header: `role="button"`, `tabIndex 0`, focus programmatico OK; `keydown
  Space` → espande, `keydown Enter` → ricollassa, entrambi con il setting che
  segue
- lista: `role="region"`, `aria-labelledby` = id dell'header

Stato del vault ripristinato a fine sessione: `chatsCollapsed: []`, tema
`obsidian`.

---

## 5. Rimasto fuori, di proposito

- **Il pin sposta ancora il titolo.** `.mva-chats-pin` sta dentro
  `.mva-chats-line` prima del nome, quindi una riga pinnata ha il titolo ~16px
  più a destra delle altre. È pre-esistente e non è uno *stato* che cambia da
  solo (il gutter esiste per quello), ma ora che la colonna è pulita si nota di
  più. Candidato a un giro successivo: o il pin va nel gutter accanto al dot, o
  prende una colonna riservata sua.
- **`--interactive-accent` in questo tema è `#dadada`**, quindi il dot "running"
  legge quasi-bianco invece che colorato. Tenuto com'è per coerenza: la rail
  usava lo stesso token e il testo "Working" sulla stessa riga pure. A
  distinguerlo restano la dimensione (6px vs 4px) e il pulse.
- **Findings dell'hook `impeccable`** su `styles.css` (side-tab:984,
  layout-transition:2130/3657/3719/4776): tutti su righe pre-esistenti lontane
  da questo blocco, fuori scope. Non toccati.
