# Custom Change Log

## 2026-06-01 - Kiro Opus 4.8 text-only stream fallback and frame parsing

Changed `src/providers/claude/claude-kiro.js` so Kiro streams that send visible
assistant text in `text` payloads instead of `content` payloads no longer finish
as empty Claude responses, and so binary AWS event stream frames are parsed by
frame boundaries before scanning payload JSON.

What changed:

- Added a `text` fallback event path in the Kiro AWS event stream parser.
- Buffered `text` fallback chunks and emitted them as Claude content only when
  the stream completed without any normal `content` or tool output, avoiding
  duplicate output on normal mixed streams.
- Treated empty or whitespace-only `content` fields as non-visible when a Kiro
  event also contains visible `text`, so those placeholder fields no longer
  suppress the fallback path.
- Kept the Kiro stream buffer as bytes and parsed plausible AWS event stream
  frame boundaries before decoding payload JSON, preventing binary headers or
  split frame preludes from blocking later visible output.
- Added focused coverage in `tests/kiro-stream-usage-estimation.test.js` for
  text-only streams, mixed text/content streams, and empty-content/text
  fallback streams, binary AWS frames, and split-frame buffering.

Verification:

- `node --check src\providers\claude\claude-kiro.js`
- `npx jest --runInBand --runTestsByPath tests/kiro-stream-usage-estimation.test.js`
- `npx jest --runInBand --runTestsByPath tests\claude-kiro-request.test.js tests\kiro-provider-leak-sanitization.test.js tests\kiro-stream-usage-estimation.test.js`
- Restarted the local Sub2API dev stack with `scripts\dev-stack.cmd restart`.
- Local real Claude Code `claude-opus-4-8` `--print --output-format stream-json`
  test through Sub2API: 6 independent requests, 0 client-empty responses.
- Local real Claude Code interactive CLI test through Sub2API: ordinary TTY
  sessions produced `external, cli` usage rows with visible output.
- Sub2API usage log check after the restart: 18 `claude-opus-4-8` records,
  including 6 `external, cli` records, 0 records with `output_tokens=0`.
- Local `claude-opus-4-6` non-regression stream test through Sub2API returned
  visible SSE content and usage row `15667` with `output_tokens=27`.
- A2 logs after the restart showed no new Kiro empty-output diagnostic entries.
- Added `docs/KIRO_OPUS_47_48_EMPTY_STREAM_DEBUG_2026-06-01.md` to record the
  investigation, failed hypotheses, fix shape, verification, and residual
  diagnostic plan.

## 2026-06-01 - Kiro explicit-history conversation isolation

Changed `src/providers/claude/claude-kiro.js` so Claude Code requests that
already include explicit multi-turn history use a fresh Kiro/Amazon Q
`conversationId` per request instead of reusing the metadata-derived session ID.

What changed:

- Kept metadata-derived stable `conversationId` only for single-turn requests
  where the upstream server-side conversation cache is not being combined with
  explicit client history.
- Switched multi-turn explicit-history requests to fresh conversation IDs to
  avoid A2A server-side state conflicting with the full history sent by Claude
  Code, which could produce successful streams with no visible output.
- Added focused request-conversion coverage in
  `tests/claude-kiro-request.test.js`.

Verification:

- `node --check src\providers\claude\claude-kiro.js`
- `npx jest --runInBand --runTestsByPath tests/claude-kiro-request.test.js tests/kiro-stream-usage-estimation.test.js tests/kiro-provider-leak-sanitization.test.js`

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
