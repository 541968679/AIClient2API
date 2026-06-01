# Custom Change Log

## 2026-06-01 - Kiro thinking-only stream completion semantics

Changed `src/providers/claude/claude-kiro.js` so Kiro thinking-only Claude
responses finish as completed turns instead of reporting `max_tokens`.

What changed:

- Kept the minimal text fallback for thinking-only responses so Claude clients
  still receive a visible text block.
- Changed thinking-only stream and non-stream stop reasons from `max_tokens` to
  `end_turn` to avoid clients treating the response as truncated and issuing an
  immediate continuation request.
- Preserved the previous guard that skips provider-internal stream retries after
  output has already been yielded.
- Added focused coverage in `tests/kiro-stream-usage-estimation.test.js`.

Verification:

- `node --check src\providers\claude\claude-kiro.js`
- `npx jest tests/kiro-stream-usage-estimation.test.js --runInBand`

## 2026-06-01 - docs: add agent rules for Sub2API sidecar work

Added repository-root agent rules and an explicit Sub2API integration contract
so work started from this checkout no longer depends on the Sub2API repository's
`AGENTS.md`.

What changed:

- Added `AGENTS.md` as the AIClient2API rule entry point for agents.
- Added `docs/SUB2API_INTEGRATION.md` with local ports, sidecar relationship,
  API key/route contract surfaces, production ownership, and troubleshooting
  entry points.
- Documented that this repository should use its existing npm scripts for
  current workflows and should not inherit Sub2API's frontend package-manager
  restriction.

Verification:

- Confirmed the new rule file and integration document are present and readable.
- Confirmed the Sub2API integration ports remain `3000` and `3100`.

## 2026-05-29 - Claude Kiro identity leak mitigation

Changed `src/providers/claude/claude-kiro.js` to reduce user-visible leakage of
Kiro/CodeWhisperer/Amazon Q provider identity when requests are routed through
`claude-kiro-oauth`.

What changed:

- Added a stronger identity guard to the Kiro request system prompt. If users
  ask who the assistant is, the provider is instructed to answer as Claude and
  not disclose internal providers, IDE names, gateways, routing layers, upstream
  services, or transport details.
- Added provider-leak text sanitization for Kiro, KiroIDE, Kiro OAuth,
  CodeWhisperer, Amazon Q, and the `claude-kiro-oauth` route name.
- Applied sanitization to non-stream responses, Claude content blocks, streaming
  text/thinking deltas, and Kiro upstream error messages.
- Added a small streaming tail buffer so split chunks such as `Ki` + `ro IDE`
  can still be sanitized before reaching clients.
- Added focused coverage in `tests/kiro-provider-leak-sanitization.test.js`.

Verification:

- `npx jest tests/kiro-provider-leak-sanitization.test.js tests/kiro-stream-usage-estimation.test.js --runInBand`
- `npx jest --runInBand --testPathPattern=kiro`
- `node --check src\providers\claude\claude-kiro.js`
