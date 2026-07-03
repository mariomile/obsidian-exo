# Product

## Register

product

## Users

Mario — a product manager and 0-to-1 builder who uses Claude Code daily as his primary dev tool, working inside Obsidian on his personal knowledge vault (marioverse.ai). He opens Exo mid-flow, without leaving the note he's editing: asking questions about the vault, running edits, kicking off research, or orchestrating multi-step work — all with the vault as the agent's working directory. The job to be done on any given screen is almost always "keep going without switching context" — the interface should never be the thing standing between him and the next tool call.

## Product Purpose

Exo is a frontend for the Claude Code CLI (and Codex CLI) embedded in the Obsidian sidebar — same engine, same native tools, same billing, same on-disk transcripts as the terminal, with an Obsidian-native surface on top (vault-aware context, interactive permission/ask cards, inline note editing). North star, in Mario's words: *"Exo deve essere davvero pari a Claude Code, ma utilizzabile da Obsidian. Priorità #1: token + performance = una gioia da usare."* Success is parity with the terminal experience, not a fancier chatbot — every design decision is judged against "would this slow Claude Code down, or would this get in its way?"

## Brand Personality

Confident, minimal, precise. Exo doesn't perform enthusiasm or decorate itself — it trusts the content (the agent's text, tool output, code) to be the protagonist, and gets out of the way. Chrome exists only when it carries information (a tool name, a risk level, a token count); anything ornamental gets cut.

## Anti-references

- **Generic AI chatbot** — ChatGPT-style bubble avatars, gradient sparkle accents, "AI is thinking" theatrics. Exo's own working-indicator and card system exist specifically to avoid this register.
- **Dense dev-tool chrome** — VSCode/Cursor-style technical density, monospace-everywhere, IDE-grade information overload. Exo lives in a note-taking app; it should feel closer to a quiet sidebar panel than an embedded terminal.

Notion's own visual restraint (quiet ticks, hover-revealed detail, information that shows up only when asked for) is a *positive* reference, not an anti-reference — see the outline rail, directly ported from Mario's own notion-outline plugin.

## Design Principles

1. **The engine is the product; the UI is not the show.** Surface what the CLI is doing (thinking, tool calls, results) without adding visual weight of its own.
2. **Content is the protagonist.** Tool cards, footers, and metadata rows stay muted and secondary — a single accent color or bold weight is enough to mark "important," never a card-within-a-card.
3. **Progressive disclosure over persistent chrome.** Detail (timestamps, full paths, token counts) reveals on hover/click rather than sitting on screen by default — same pattern as the context ring and the outline rail.
4. **Match Obsidian's own restraint.** Colors and surfaces derive from the active theme's CSS variables; density and spacing should feel like a natural extension of the sidebar, not a foreign app bolted on.
5. **Never slower than the terminal.** Any animation, card, or visual flourish is cut if it adds latency or gets between Mario and the next keystroke.

## Accessibility & Inclusion

Current baseline (from the 2026-07-02 hardening pass) is the standing bar: `role=button` + keyboard nav (Enter/Space) on all custom interactive elements, visible focus states, `prefers-reduced-motion` alternatives for every animation, and theme-derived contrast (no hardcoded colors that could fail against a light theme). No additional WCAG level is targeted beyond this baseline.
