import type { WriteQueue } from "../core/write-queue";
import type { ResearchReceipt, ResearchReceiptSource } from "../core/research";

const REPORTS_DIR = "_system/reports";

export interface ResearchDossierRequest {
  /** The UI sets this only inside the explicit Save dossier click handler. */
  approved: boolean;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  question: string;
  response: string;
  receipt: ResearchReceipt;
}

export interface ResearchDossierAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
  ensureDir(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
}

export type ResearchDossierWriteResult =
  | { status: "skipped"; reason: "approval-required" }
  | { status: "saved"; path: string; created: boolean };

function slugify(question: string): string {
  return question
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "") || "research";
}

export function researchDossierPath(request: Pick<ResearchDossierRequest, "date" | "question">): string {
  return `${REPORTS_DIR}/${request.date}-${slugify(request.question)}.md`;
}

function extractSection(markdown: string, names: RegExp): string | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^#{2,3}\s+/.test(line) && names.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end++;
  return lines.slice(start + 1, end).join("\n").trim() || null;
}

function findingsOnly(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/)?.[1] ?? "";
    if (heading) {
      skipping = /^(?:conflicts?|open questions?)\b/i.test(heading.trim());
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}

function sourceStatus(source: ResearchReceiptSource): string {
  switch (source.status) {
    case "consulted": return "Checked";
    case "failed": return "Failed";
    case "unavailable": return "Unavailable";
    case "skipped": return "Skipped";
  }
}

function sourceKind(source: ResearchReceiptSource): string {
  if (source.kind === "mcp") return "MCP";
  return source.kind[0].toUpperCase() + source.kind.slice(1);
}

export function buildResearchDossier(request: ResearchDossierRequest): string {
  const findings = findingsOnly(request.response) || "_(No findings were returned.)_";
  const firstParagraph = findings.split(/\n\s*\n/)[0].replace(/^#+\s+/, "").trim();
  const conflicts = extractSection(request.response, /^#{2,3}\s+conflicts?\b/i)
    ?? "_(No separate conflicts section was provided.)_";
  const openQuestions = extractSection(request.response, /^#{2,3}\s+open questions?\b/i)
    ?? "_(No separate open-questions section was provided.)_";
  const receipt = request.receipt.sources.map((source) =>
    `- ${sourceKind(source)} · ${sourceStatus(source)} · ${source.label}`
    + (source.detail ? ` — ${source.detail}` : "")
  ).join("\n");

  return [
    "---",
    "type: report",
    "tags:",
    "  - type/reference",
    `date: ${request.date}`,
    "---",
    "",
    `# Research — ${request.question}`,
    "",
    "## Question",
    "",
    request.question,
    "",
    "## Scope",
    "",
    `- Sources: ${request.receipt.scope}`,
    `- Depth: ${request.receipt.depth}`,
    `- Result: ${request.receipt.status}`,
    "",
    "## Summary",
    "",
    firstParagraph,
    "",
    "## Cited findings",
    "",
    findings,
    "",
    "## Conflicts",
    "",
    conflicts,
    "",
    "## Open questions",
    "",
    openQuestions,
    "",
    "## Source receipt",
    "",
    receipt || "- No sources consulted",
    "",
    `Research completed: ${new Date(request.receipt.completedAt).toISOString()}`,
    "",
  ].join("\n");
}

function numberedPath(basePath: string, index: number): string {
  return index === 1 ? basePath : basePath.replace(/\.md$/, `-${index}.md`);
}

/** One approval-gated, serialized, non-overwriting write boundary. */
export function writeResearchDossier(
  adapter: ResearchDossierAdapter,
  queue: WriteQueue,
  request: ResearchDossierRequest
): Promise<ResearchDossierWriteResult> {
  if (!request.approved) {
    return Promise.resolve({ status: "skipped", reason: "approval-required" });
  }
  const content = buildResearchDossier(request);
  const basePath = researchDossierPath(request);
  return queue.enqueue(async () => {
    if (!await adapter.exists(REPORTS_DIR)) await adapter.ensureDir(REPORTS_DIR);
    for (let index = 1; index <= 999; index++) {
      const path = numberedPath(basePath, index);
      if (await adapter.exists(path)) {
        if (await adapter.read(path) === content) {
          return { status: "saved", path, created: false };
        }
        continue;
      }
      await adapter.write(path, content);
      return { status: "saved", path, created: true };
    }
    throw new Error("Could not allocate a unique research dossier path.");
  });
}
