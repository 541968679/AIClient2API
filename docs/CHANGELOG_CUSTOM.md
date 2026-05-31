# Custom Change Log

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

