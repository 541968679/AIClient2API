# Kiro Opus 4.7/4.8 Empty Stream Debug - 2026-06-01

## Summary

Sub2API observed intermittent Claude Code empty replies when routing
`claude-opus-4-7` and `claude-opus-4-8` through the AIClient2API Kiro provider.
The upstream Kiro call was not proven empty. The strongest diagnostic showed
AIClient2API receiving stream bytes but failing to parse any JSON payloads from
the stream buffer, so the downstream Anthropic-compatible response could finish
without visible assistant text.

This document records the investigation and the current staged fix.

## Symptom

- Client path: Claude Code -> Sub2API `/antigravity/v1/messages` ->
  AIClient2API `/claude-kiro-oauth/v1/messages` -> Kiro.
- Affected models under investigation: `claude-opus-4-7` and
  `claude-opus-4-8`.
- The issue was intermittent. Some requests returned normal visible text and
  normal usage; some ended with no visible assistant output.
- Sub2API usage rows for the failure shape included `output_tokens=0`.
- 429 responses are not part of this investigation. Empty replies caused by a
  legitimate upstream 429 are expected and separate from the stream parsing
  issue.

Representative local diagnostic:

- Sub2API usage row: `15641`, `claude-opus-4-8`, `output_tokens=0`.
- Client user agent: `claude-cli/2.1.159 (external, cli)`.
- AIClient2API request id observed in logs: `fc346b7f`.
- Kiro stream diagnostic: `chunks=47`, `chunkChars=11469`,
  `remainingBufferChars=11458`, `jsonObjects=0`.

The important point is that `chunkChars` was non-zero while `jsonObjects` was
zero. That means the old parser received stream data but failed to recover any
payload JSON from it.

## Investigation Notes

Initial theory focused on Kiro sometimes putting visible text in a `text` field
instead of the `content` field. That was real and needed compatibility, but it
did not fully explain the empty stream diagnostic above because that diagnostic
had `jsonObjects=0`.

The later diagnostic shifted the root cause to stream framing:

- Kiro responses can arrive as AWS event stream binary frames.
- The previous parser accumulated chunks as strings and searched for JSON
  objects directly.
- Binary frame headers and split frame preludes can leave the string scanner
  stuck before the payload JSON.
- If the buffer starts with fewer than 12 bytes, it may be an incomplete AWS
  event stream prelude and must be retained until more bytes arrive.

## Fix

Changed `src/providers/claude/claude-kiro.js`:

- Keep the Kiro stream buffer as a `Buffer`.
- Parse plausible AWS event stream frame boundaries before decoding payload
  JSON.
- Preserve incomplete frames across chunks, including short preludes smaller
  than 12 bytes.
- Fall back to the older text scanner only when no plausible frames were parsed.
- Add a `text` fallback event path for Kiro payloads that contain visible
  assistant output in `text` instead of `content`.
- Do not let empty or whitespace-only `content` suppress a visible `text`
  fallback in the same payload.
- Emit buffered `text` fallback content only when the stream finished without
  normal visible content or tool output, preventing duplicate output on mixed
  streams.
- Keep empty-output diagnostics so future real failures show whether bytes,
  JSON payloads, `content`, and `text` fields were observed.

Added focused tests in `tests/kiro-stream-usage-estimation.test.js` for:

- text-only Kiro payloads;
- mixed `text` and normal `content`;
- empty or whitespace `content` with visible `text`;
- AWS event stream binary frames;
- AWS frames split across chunks.

## Verification

Local static and unit checks:

- `node --check src\providers\claude\claude-kiro.js`
- `npx jest --runInBand --runTestsByPath tests\claude-kiro-request.test.js tests\kiro-provider-leak-sanitization.test.js tests\kiro-stream-usage-estimation.test.js`
- Result: 3 suites passed, 16 tests passed.

Local real-path checks through Sub2API after restarting the local stack:

- 18 real `claude-opus-4-8` usage rows after the restart, all with
  `output_tokens > 0`.
- 6 of those rows were Claude Code `external, cli` requests.
- No new `empty visible output diagnostic` entries in AIClient2API logs during
  that test window.
- A direct non-regression test for `claude-opus-4-6` returned normal SSE content
  and a Sub2API usage row:
  - `usage_logs.id=15667`
  - `input_tokens=1509`
  - `output_tokens=27`
  - `cache_read_tokens=3441`

## Current Status

This is a staged fix, not a proof that no future upstream stream shape can
produce an empty reply. The parser now handles the observed failure mode where
AIClient2API received bytes but failed to parse JSON payloads. The diagnostic
logging remains intentionally in place so production can distinguish:

- upstream returns no useful payload;
- AIClient2API receives bytes but parses no JSON;
- AIClient2API parses JSON but sees no visible `content` or `text`;
- downstream usage is zero because the request failed before normal completion.

