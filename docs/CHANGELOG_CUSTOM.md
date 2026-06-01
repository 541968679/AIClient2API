# Custom Change Log

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
