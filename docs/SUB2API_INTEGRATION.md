# Sub2API Integration

Last updated: 2026-06-01

## Purpose

This document records how this AIClient2API checkout participates in the
Sub2API local and production stack. It is the AIClient2API-side integration
contract; the Sub2API-side index lives at
`E:\cursor project\api2sub\docs\dev\RELATED_PROJECTS.md`.

## Local Relationship

- AIClient2API source checkout: `E:\cursor project\AIClient2API`.
- Sub2API source checkout: `E:\cursor project\api2sub`.
- AIClient2API API/Web UI listens on `http://127.0.0.1:3000` by default.
- AIClient2API Master/process management uses port `3100`.
- Sub2API local backend/frontend remain on `18081` and `15174`.

Do not change AIClient2API's ports only to avoid a temporary local conflict
without also updating the Sub2API integration docs.

## Runtime Contract

Sub2API can route upstream account traffic to AIClient2API for client-bound
providers. Common routes include Kiro, Gemini CLI, Antigravity, Qwen, and custom
OpenAI/Claude-compatible providers.

Important contract points:

- Sub2API stores the AIClient2API API key in its account/channel configuration.
- AIClient2API validates the configured key before serving gateway traffic.
- Kiro/Claude-compatible calls may use routes such as
  `/claude-kiro-oauth/v1/messages` or `/claude-kiro-oauth/v1/chat/completions`.
- Route names, auth behavior, usage reporting, and streaming chunk semantics are
  cross-repository contract surfaces.

## Production Relationship

Sub2API production compose includes an `aiclient2api` sidecar. Production
deployment orchestration and image selection are documented in the Sub2API
repository; this repository should not redefine that deployment flow.

When production-facing AIClient2API requirements change, update:

- this file;
- `docs/CHANGELOG_CUSTOM.md` in this repository;
- `E:\cursor project\api2sub\docs\dev\RELATED_PROJECTS.md`;
- the relevant Sub2API deployment or gateway docs if the contract changes.

## Troubleshooting Entry Points

- Provider adapter guide: `docs/PROVIDER_ADAPTER_GUIDE.md`.
- Kiro/custom changes: `docs/CHANGELOG_CUSTOM.md`.
- Sub2API-side Kiro history: `E:\cursor project\api2sub\docs\dev\KIRO_PROXY.md`.
- Sub2API-side web search debugging:
  `E:\cursor project\api2sub\docs\dev\KIRO_WEB_SEARCH_DEBUG.md`.

## Change Logging

AIClient2API internal changes go in `docs/CHANGELOG_CUSTOM.md`. Changes that
affect Sub2API route paths, ports, auth/API key behavior, deployment, streaming,
or usage semantics must also be logged in Sub2API documentation.
