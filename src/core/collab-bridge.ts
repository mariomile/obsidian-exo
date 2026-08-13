/**
 * Exo Collabo protocol, as pure functions over an injected HTTP callable.
 *
 * Deliberately Obsidian-free: the plugin passes a `requestUrl` adapter, tests
 * pass a recorder. Every route here is the public SDK surface documented in the
 * service's own AGENT_CONTRACT.md, not the hosted-product compatibility aliases.
 *
 * The agent is a proposer, never a committer: `suggestion.accept`,
 * `suggestion.reject` and `rewrite.apply` are intentionally NOT in `CollaboOp`.
 * Promoting a proposal to canonical text is the owner's move, made in the web
 * client.
 */

export type ShareRole = "viewer" | "commenter" | "editor";

/** A role this vault can actually vouch for, plus "unknown" for a document
 *  it only imported: a pasted link hands over a token, never the role it
 *  grants, so there is nothing honest to store but "unknown" until the
 *  service starts saying otherwise. */
export type StoredShareRole = ShareRole | "unknown";

/** Service coordinates. `apiKey` authenticates document CREATION only; every
 *  per-document call authenticates with that document's own token instead. */
export interface CollaboConfig {
  baseUrl: string;
  apiKey: string;
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** Any non-2xx answer from the service. Carries the status so callers can tell
 *  "you lost access" (401/403/404) from "the service is unwell" (5xx). */
export class CollaboError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "CollaboError";
  }
}

export interface CreatedDocument {
  slug: string;
  /** The link to hand to a human: tokenised when the service returned one, so
   *  the recipient can open it without an account. */
  shareUrl: string;
  ownerSecret: string;
  accessToken: string;
  accessRole: ShareRole;
}

export interface DocumentState {
  markdown: string;
  updatedAt: string | null;
}

export interface CollaboEvent {
  id: number;
  type: string;
  by: string | null;
  at: string | null;
}

/** The ops the agent is allowed to send. Both are proposals. */
export type CollaboOp =
  | { type: "comment.add"; by: string; text: string; quote?: string }
  | {
      type: "suggestion.add";
      by: string;
      kind: "insert" | "delete" | "replace";
      quote: string;
      content?: string;
    };

/** A pasted share link taken apart. `baseUrl` is null for a bare slug, meaning
 *  the caller should fall back to the configured service. */
export interface ShareRef {
  baseUrl: string | null;
  slug: string;
  token: string | null;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Non-cryptographic hash, shared by every caller that needs an idempotency
 *  key derived from content rather than the clock: `collabo-commands.ts`
 *  keys document CREATE on the note's path, `collabo-tools.ts` keys each
 *  comment/suggestion on its own fields. Both need the same property — the
 *  same input always produces the same key, so a dropped response followed
 *  by a retry (human re-running a command, or a model retrying a timed-out
 *  tool call) lands on the key the service already saw instead of minting a
 *  duplicate. `Date.now()` cannot do that; a hash of the operation can. */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** One place where a non-2xx becomes a typed throw, so no caller has to
 *  remember to check `status` and none of them silently treats an error page as
 *  a document. */
async function send(http: HttpFn, req: HttpRequest): Promise<unknown> {
  const res = await http(req);
  if (res.status < 200 || res.status >= 300) {
    const body = isRecord(res.json) ? res.json : {};
    const code = typeof body.error === "string" ? body.error : null;
    const detail = typeof body.message === "string" ? body.message : code;
    throw new CollaboError(detail || `Request failed with ${res.status}`, res.status, code);
  }
  return res.json;
}

const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export async function createDocument(
  http: HttpFn,
  cfg: CollaboConfig,
  doc: { markdown: string; title: string; role: ShareRole },
  idempotencyKey: string,
): Promise<CreatedDocument> {
  const json = await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents`,
    method: "POST",
    headers: { ...authHeaders(cfg.apiKey), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ markdown: doc.markdown, title: doc.title, role: doc.role }),
  });
  const b = isRecord(json) ? json : {};
  const slug = str(b.slug);
  if (!slug) throw new CollaboError("The service created no document.", 502);
  const ownerSecret = str(b.ownerSecret);
  // A blank ownerSecret here is indistinguishable from the sentinel
  // isOwnedShare uses elsewhere to mean "this vault only imported the
  // document" — this vault just CREATED it, so a blank secret can only mean
  // a malformed or schema-drifted response, never a legitimate owner-less
  // document. Passing it through would misrecord a document this vault owns
  // as not-owned, permanently.
  if (!ownerSecret) throw new CollaboError("The service created the document but returned no owner secret.", 502);
  return {
    slug,
    // tokenUrl is the one a recipient can actually open; shareUrl alone may
    // require an account on hosted deployments.
    shareUrl: str(b.tokenUrl) || str(b.shareUrl),
    ownerSecret,
    accessToken: str(b.accessToken),
    accessRole: (str(b.accessRole) || "commenter") as ShareRole,
  };
}

export async function fetchState(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
): Promise<DocumentState> {
  const json = await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/state`,
    method: "GET",
    headers: authHeaders(token),
  });
  const b = isRecord(json) ? json : null;
  // A 2xx with no markdown string is a schema drift or a degraded response,
  // not an empty document: surfacing it as an error keeps a malformed reply
  // from silently blanking real content when it lands in a vault note.
  if (!b || typeof b.markdown !== "string") {
    throw new CollaboError("The service returned a malformed document state.", 502);
  }
  return { markdown: b.markdown, updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : null };
}

export async function postOp(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
  op: CollaboOp,
  idempotencyKey: string,
): Promise<void> {
  await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/ops`,
    method: "POST",
    headers: { ...authHeaders(token), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(op),
  });
}

export async function pendingEvents(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
  after: number,
  limit = 50,
): Promise<CollaboEvent[]> {
  const json = await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/events/pending?after=${after}&limit=${limit}`,
    method: "GET",
    headers: authHeaders(token),
  });
  const raw = isRecord(json) && Array.isArray(json.events) ? json.events : [];
  // An event with no numeric id can never be passed to ackEvents' cursor, so
  // admitting it with a fake id (e.g. 0) risks stalling a caller that acks
  // through the max id seen. Drop it instead.
  return raw
    .filter(isRecord)
    .filter((e): e is Record<string, unknown> & { id: number } => typeof e.id === "number")
    .map((e) => ({
      id: e.id,
      type: str(e.type),
      by: typeof e.by === "string" ? e.by : null,
      at: typeof e.at === "string" ? e.at : null,
    }));
}

export async function ackEvents(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
  through: number,
): Promise<void> {
  await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/events/ack`,
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ through }),
  });
}

/** Accepts a full share link (`…/d/<slug>?token=…`) or a bare slug. Returns
 *  null for anything else, so the import command can refuse a paste instead of
 *  inventing a slug out of it. */
export function parseShareRef(input: string): ShareRef | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return { baseUrl: null, slug: raw, token: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const m = /^\/d\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  return { baseUrl: `${url.protocol}//${url.host}`, slug: m[1], token: url.searchParams.get("token") };
}
