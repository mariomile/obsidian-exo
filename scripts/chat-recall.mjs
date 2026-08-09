#!/usr/bin/env node
// chat-recall.mjs — local semantic index over Exo conversations.
//
//   node chat-recall.mjs index <pluginDir>            build/update the index
//   node chat-recall.mjs query <pluginDir> "text" [N] top-N conversation ids
//   node chat-recall.mjs status <pluginDir>
//
// Same model and the same E5 contract as the vault's semantic recall
// (`~/.marioverse/semantic-recall/semantic.mjs`): documents are embedded as
// "passage: ...", queries as "query: ...", and mixing the two costs real
// quality. Deliberately the same model, so a chat and a note are comparable
// points in one space rather than two incompatible ones.
//
// The embedder is NOT a dependency of the plugin. It is resolved from the
// vault's semantic-recall install if that exists, and its absence is a normal
// outcome reported through exit code 3 — the sidebar keeps its instant lexical
// filter and simply never offers the semantic pass. A search box that breaks
// when an optional local model is missing would be worse than one that never
// had it.
//
// Read-only over conversations.json; every artifact lives in <pluginDir>.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const MODEL = "Xenova/multilingual-e5-small";
const DIM = 384;
/** Title plus the tail of the exchange. Note-level recall, not chunk RAG: the
 *  question is "which conversation", never "which line of it". */
const MAX_CHARS = 1200;
const EMBEDDER_HOME = join(homedir(), ".marioverse", "semantic-recall");

const [cmd, pluginDir, ...rest] = process.argv.slice(2);
if (!cmd || !pluginDir) {
  console.error('usage: chat-recall.mjs index|query|status <pluginDir> ["text"] [N]');
  process.exit(1);
}

const INDEX_DIR = join(pluginDir, "chat-index");
const META_PATH = join(INDEX_DIR, "meta.json");
const VEC_PATH = join(INDEX_DIR, "vectors.f32");

/** Load `@huggingface/transformers` from the vault's install. Exits 3 — not 1 —
 *  when it is absent, so the caller can tell "not available here" apart from
 *  "something broke". */
async function loadPipeline() {
  // Resolve the package the way Node would from inside the embedder install, so
  // its `exports` map picks the right build. Guessing a dist filename breaks
  // silently the next time the package reorganises its output.
  for (const from of [join(EMBEDDER_HOME, "package.json"), import.meta.url]) {
    try {
      const req = createRequire(from);
      const mod = await import(pathToFileURL(req.resolve("@huggingface/transformers")).href);
      if (mod.pipeline) return mod.pipeline;
    } catch {
      // Try the next resolution root.
    }
  }
  console.error("chat-recall: embedder unavailable (no local @huggingface/transformers)");
  process.exit(3);
}

/** Every stored conversation, live plus archived. Archived ones are indexed on
 *  purpose: the sidebar hides them, but "find that thing I archived" is exactly
 *  the query a lexical filter cannot answer. */
function readConversations() {
  const out = [];
  for (const base of ["conversations.json", "conversations-archive.json"]) {
    const p = join(pluginDir, base);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : [];
      for (const c of list) if (c && typeof c.id === "string") out.push(c);
    } catch {
      // A corrupt store is the chat view's problem to report, not the indexer's.
    }
  }
  return out;
}

function messageText(m) {
  if (!m) return "";
  if (typeof m.text === "string" && m.text.trim()) return m.text;
  return (m.segments ?? [])
    .filter((s) => s?.t === "text")
    .map((s) => s.md ?? "")
    .join(" ");
}

/** Title first, then the most recent exchange working backwards. Recency beats
 *  completeness here: what a conversation is *about* is set early, but what you
 *  remember about it is usually where you left off. */
function digest(c) {
  const parts = [c.title ?? ""];
  let budget = MAX_CHARS;
  for (let i = (c.messages?.length ?? 0) - 1; i >= 0 && budget > 0; i--) {
    const t = messageText(c.messages[i]).replace(/\s+/g, " ").trim();
    if (!t) continue;
    const take = t.slice(0, budget);
    parts.push(take);
    budget -= take.length;
  }
  const text = parts.join(". ").replace(/\s+/g, " ").trim();
  return text.length < 8 ? null : text;
}

const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function loadIndex() {
  if (!existsSync(META_PATH) || !existsSync(VEC_PATH)) return { entries: [], vectors: new Float32Array(0) };
  try {
    const meta = JSON.parse(readFileSync(META_PATH, "utf8"));
    if (meta.model !== MODEL || meta.dim !== DIM) return { entries: [], vectors: new Float32Array(0) };
    const buf = readFileSync(VEC_PATH);
    return { entries: meta.entries, vectors: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
  } catch {
    return { entries: [], vectors: new Float32Array(0) };
  }
}

function saveIndex(entries, vectors) {
  mkdirSync(INDEX_DIR, { recursive: true });
  const tmpM = `${META_PATH}.tmp`;
  const tmpV = `${VEC_PATH}.tmp`;
  writeFileSync(tmpM, JSON.stringify({ model: MODEL, dim: DIM, builtAt: new Date().toISOString(), entries }));
  writeFileSync(tmpV, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  renameSync(tmpM, META_PATH);
  renameSync(tmpV, VEC_PATH);
}

async function embedBatch(pipe, texts) {
  const out = await pipe(texts, { pooling: "mean", normalize: true });
  const flat = out.data;
  return texts.map((_, i) => new Float32Array(flat.buffer, flat.byteOffset + i * DIM * 4, DIM));
}

/** Incremental by content hash: a conversation is re-embedded only when its
 *  digest actually changed, so the common case (one chat got a new turn) costs
 *  one embedding, not fifty. */
async function cmdIndex() {
  const convos = readConversations();
  const { entries: oldEntries, vectors: oldVectors } = loadIndex();
  const oldById = new Map(oldEntries.map((e, i) => [e.id, i]));

  const wanted = [];
  for (const c of convos) {
    const text = digest(c);
    if (!text) continue;
    wanted.push({ id: c.id, h: hash(text), text });
  }

  const fresh = wanted.filter((w) => oldById.get(w.id) === undefined || oldEntries[oldById.get(w.id)].h !== w.h);
  let pipe = null;
  const newVecs = new Map();
  if (fresh.length) {
    pipe = await (await loadPipeline())("feature-extraction", MODEL, { dtype: "q8" });
    const BATCH = 16;
    for (let i = 0; i < fresh.length; i += BATCH) {
      const slice = fresh.slice(i, i + BATCH);
      const vecs = await embedBatch(pipe, slice.map((s) => `passage: ${s.text}`));
      slice.forEach((s, j) => newVecs.set(s.id, vecs[j]));
    }
  }

  const entries = wanted.map(({ id, h }) => ({ id, h }));
  const vectors = new Float32Array(entries.length * DIM);
  entries.forEach((e, i) => {
    const v = newVecs.get(e.id);
    if (v) { vectors.set(v, i * DIM); return; }
    const at = oldById.get(e.id);
    if (at !== undefined) vectors.set(oldVectors.subarray(at * DIM, at * DIM + DIM), i * DIM);
  });
  saveIndex(entries, vectors);
  console.log(`indexed ${entries.length} conversations (${fresh.length} embedded)`);
}

async function cmdQuery(text, n) {
  const { entries, vectors } = loadIndex();
  if (!entries.length) {
    console.error("chat-recall: no index");
    process.exit(2);
  }
  const pipe = await (await loadPipeline())("feature-extraction", MODEL, { dtype: "q8" });
  const [q] = await embedBatch(pipe, [`query: ${text}`]);
  const scores = entries.map((_, i) => {
    let dot = 0;
    const off = i * DIM;
    for (let d = 0; d < DIM; d++) dot += q[d] * vectors[off + d];
    return [dot, i];
  });
  scores.sort((a, b) => b[0] - a[0]);
  for (const [score, i] of scores.slice(0, n)) console.log(`${score.toFixed(4)}\t${entries[i].id}`);
}

if (cmd === "index") await cmdIndex();
else if (cmd === "query") await cmdQuery(rest[0] ?? "", parseInt(rest[1] ?? "12", 10));
else if (cmd === "status") {
  const { entries } = loadIndex();
  console.log(entries.length ? `${entries.length} conversations indexed` : "no index");
} else {
  console.error('usage: chat-recall.mjs index|query|status <pluginDir> ["text"] [N]');
  process.exit(1);
}
