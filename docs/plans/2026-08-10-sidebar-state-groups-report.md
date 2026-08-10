# Sidebar chats — grouping by state

**Data:** 2026-08-10 · **Commit:** `c1f5655` (child-tree), `e1e3819` (chat-rows + view)
**Verifica:** 136 file / 2175 test, 0 fail · `pnpm typecheck` pulito · `pnpm lint` 0 errori (8 warning preesistenti) · `src/view.ts` invariato a 6577 righe (tetto 6600)

---

## Forma esportata (contratto per il task UI)

```ts
export type ChatSectionKey =
  | "needsYou" | "running" | "open" | "pinned" | "settled" | "related"
  | `day:${TimeGroupLabel}`;          // TimeGroupLabel = Today | Yesterday | This week | This month | Older

export interface ChatSection {
  key: ChatSectionKey;   // identità stabile: la UI ci aggancia riuso DOM e stato collapsed
  label: string;         // testo a schermo, mai parsato
  items: ChatRow[];
}

export interface ChatListVM {
  sections: ChatSection[];  // già ordinate, già ripulite dalle vuote
  total: number;            // righe prima del filtro query
  matched: number;          // righe dopo il filtro, related incluse
}
```

`ChatRow` è invariato (`depth: 0 | 1`, `lane`, `reason`, `badge`, `unseen`, `open`, `pinned`, `parentConvoId`).

Il renderer itera una sola lista: `vm.sections.forEach(...)`. Non deve mai derivare una key
dal label — il label è testo di display, la key è l'identità. Ordine garantito:

- **activity** — `needsYou`, `running`, `open`, `pinned`, `settled`, poi `related`
- **days** — `day:*` in ordine cronologico, poi `related`

`related` è sempre ultima quando esiste. Le sezioni vuote non compaiono affatto.

Label correnti: `Needs you` · `Running` · `Open` · `Pinned` · `Settled` · `Related`.

---

## CHANGE 1 — la liveness batte l'annidamento

Ancorata (mai rilocata sotto un parent) è **l'appartenenza alle prime due sezioni**, non una
lista di lane riscritta a mano:

```ts
const isAnchored = (r: ChatRow): boolean => {
  const key = activityKey(r);
  return key === "needsYou" || key === "running";
};
```

Deriva da `activityKey`, quindi ancora e sezione non possono divergere: se domani `needsYou`
cambia definizione, l'ancora la segue. Include anche le righe con badge (error/stopped), che
in `needsYou` ci finiscono: una sezione che promette "questo richiede te" non può perdere
per strada una riga a favore di un bucket cronologico.

L'ancora fissa **solo la posizione propria** della riga: i suoi figli continuano ad annidarsi
sotto di lei, nella sua sezione, come sotto qualsiasi altra radice.

**Ancoraggio solo in activity mode.** In `days` l'asse *è* la data e non esiste nessuna sezione
di stato da proteggere: un figlio che siede nel giorno del padre è la modalità che funziona
come progettata. Questo mantiene `days` identico a prima (pinnato da un test di regressione).

## CHANGE 2 — `related` non è una casa per l'annidamento

`related` esce dalla mappa `homes` del passo cross-collection e riceve un passo a casa singola
(`groupByParent`). Nessun match letterale può essere trascinato dentro "non contiene quello che
hai scritto", e nessun hit semantico può essere ripulito trascinandolo in una sezione letterale.
Dentro `related` l'annidamento continua a funzionare fra righe entrambe semantiche.

## CHANGE 3 — sei sezioni per stato

```ts
const activityKey = (r: ChatRow): ActivityKey => {
  if (r.lane === "needs-input" || r.badge) return "needsYou";
  if (r.lane === "running") return "running";
  if (r.open) return "open";
  if (r.pinned) return "pinned";
  return "settled";
};
```

Ordinamento interno: `needsYou` mette il bloccato-adesso prima del già-fallito, poi recency;
`open` mette la risposta non vista prima della tab inerte, poi recency; le altre recency pura.
`settled` non ha sotto-bucket per giorno.

### Decisione: errored **e** open → `needsYou`

Un errore è un'azione da fare; "open" è soltanto dove l'hai lasciato. Metterlo in `open`
significherebbe piazzare l'unica riga che richiede lavoro nella sezione delle righe che non
richiedono niente. Stessa logica per `stopped`: un turno interrotto è tuo da riprendere.
Test che lo pinna: *"files an errored row that is also open under Needs you, not Open"*.

`lane` e `badge` sono mutuamente esclusivi per costruzione (`deriveLane` attacca il badge solo
sul ramo idle), quindi `needsYou` e `running` non possono mai contendersi la stessa riga.

---

## Invarianti confermate

| Invariante | Dove è verificata |
|---|---|
| Ogni riga visibile compare **una sola volta** su tutte le sezioni | `never duplicates a row across Open, Pinned and Settled at once`, `never duplicates a row across the literal sections and Related` |
| Un figlio con parent assente (archiviato, filtrato, inesistente) rende a depth 0 e non sparisce | `renders an orphan at top level when the parent was archived` / `…does not exist at all` / `still shows a child when the search matches only the child` |
| Depth cappata a 1 | `caps the indent at one level` |
| Ciclo in `parentConvoId` termina, membri promossi a radice | `keeps the row count intact` |
| `total` / `matched` corretti; sezione svuotata dalla rilocazione viene eliminata | `reports total and matched separately`, `indents across sections…` (assert su `sections.map(key)`) |
| `groupByParent` resta il caso a casa singola di `groupAcrossHomes` | `child-tree.ts:128-132`, più i nuovi test `groupAcrossHomes — anchoring` |
| `days` mode invariato | intero blocco `buildChatList — days mode`, incluso `still nests a blocked child under a parent in an older bucket` |

---

## Fallimenti reali pre-fix

### CHANGE 1 + CHANGE 2, contro `4a95aaf` (forma VM vecchia, test scritti prima del fix)

```
 × liveness outranks nesting > keeps a needs-input child at top level instead of filing it under a history parent
   → expected [] to deeply equal [ [ 'c', +0 ] ]
 × liveness outranks nesting > keeps a running child at top level too
   → expected [] to deeply equal [ [ 'c', +0 ] ]
 × liveness outranks nesting > anchors the row's own position only — an anchored parent still carries its children
   → expected [] to deeply equal [ [ 'p', +0 ], [ 'c', 1 ] ]
 × related is not a nesting home > never relocates a literal match into related
   → expected [ 'p', 'c' ] to deeply equal [ 'p' ]
 × related is not a nesting home > never pulls a related row out into a literal group
   → expected [ 'p', 'c' ] to deeply equal [ 'p' ]

 Tests  5 failed | 78 passed (83)
```

Il figlio bloccato finiva davvero in un bucket di storia (`active` vuota), e `related`
assorbiva/cedeva righe (`['p','c']` dove ne era attesa una sola).

### `groupAcrossHomes`, contro `4a95aaf`

```
 × groupAcrossHomes — anchoring > leaves an anchored row at depth 0 in the home it was already given
   → expected { Object (live, old) } to deeply equal { live: [ [ 'c', +0 ] ], …(1) }
 × groupAcrossHomes — anchoring > pins an anchored row's OWN position only — its children still nest under it
   → expected { live: [], …(1) } to deeply equal { …(2) }

 Tests  2 failed | 10 passed (12)
```

### CHANGE 3 — verifica per mutazione

La forma del VM cambia con il change, quindi un run "pre-fix" sarebbe stato un type error, non
un'evidenza. Al suo posto: sei mutazioni applicate al codice finale, ognuna con i test che la
prendono.

| # | Mutazione | Test falliti |
|---|---|---|
| M1 | `activityKey` controlla `open` **prima** del badge | 2 — `lands every row in exactly one section…`, `files an errored row that is also open under Needs you` |
| M2 | il badge non conta più per `needsYou` | 8 — precedenza, decisione errored+open, stopped, ordinamento interno, i tre test badge, ancora dell'errored |
| M3 | ancoraggio disattivato (`groupAcrossHomes(homes)`) | 4 — tutto il blocco `liveness outranks nesting` |
| M4 | `related` rimessa fra le `homes` cross-section | 4 — `puts Related last`, i due test di direzione, il no-duplicati |
| M5 | ancoraggio esteso anche a `days` | 1 — `still nests a blocked child under a parent in an older bucket` |
| M6 | sezioni vuote non eliminate | 10+ |

---

## File toccati

- `src/core/child-tree.ts` — `groupAcrossHomes(homes, { isAnchored })`
- `src/core/chat-rows.ts` — `ChatSectionKey` / `ChatSection` / nuovo `ChatListVM`, `activityKey`, `isAnchored`, ordinamenti per sezione, `related` a passo singolo
- `src/ui/chat-list-view.ts` — itera `vm.sections` (nessun cambio di stile: label e iterazione soltanto)
- `tests/chat-rows.test.ts` — 93 test sulla nuova forma
- `tests/child-tree.test.ts` — 4 test nuovi sul meccanismo di ancoraggio

## Aperto per il task UI

Le sezioni hanno key stabili ma **nessuno stato collapsed** ancora: il modello espone
`key`, la persistenza (per-key, sopravvive ai re-render e al restart) è del layer UI.
`rowModel` continua a decidere la densità per riga (`rich = lane != null || open || pinned`),
quindi una riga errata in `settled` resta compatta: se il design vuole altrimenti, è una
scelta del layer visivo, non del modello.
