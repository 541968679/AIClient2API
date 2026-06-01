# AIClient2API Agent Instructions

This file is the rule entry point for AI agents working in this repository. Do
not assume Sub2API's `AGENTS.md` applies here; Sub2API integration notes are
only a contract boundary.

## Project Snapshot

AIClient2API is a Node.js ESM API proxy that exposes client-bound providers
through OpenAI-, Anthropic-, and Gemini-compatible routes. It is used locally and
as a Sub2API sidecar for providers such as Kiro, Gemini CLI, Antigravity, Qwen,
and custom OpenAI/Claude routes.

- Runtime: Node.js ESM.
- Default API/Web UI port: `3000`.
- Master/process management port: `3100`.
- Main config: `configs/config.json`.
- Custom change log: `docs/CHANGELOG_CUSTOM.md`.

## Start Here

Before changing unfamiliar code, read:

1. `README.md` for project capabilities and route/provider overview.
2. `docs/PROVIDER_ADAPTER_GUIDE.md` when adding or changing a provider.
3. `docs/CHANGELOG_CUSTOM.md` before touching Kiro/provider behavior.
4. `docs/SUB2API_INTEGRATION.md` when the task affects Sub2API sidecar usage,
   ports, API keys, routes, or deployment contracts.

## Local Commands

Use the scripts that already exist in `package.json`:

```bash
npm start
npm run start:standalone
npm test
```

Useful focused Kiro checks:

```bash
npx jest tests/kiro-provider-leak-sanitization.test.js tests/kiro-stream-usage-estimation.test.js --runInBand
npx jest --runInBand --testPathPattern=kiro
node --check src\providers\claude\claude-kiro.js
```

## Package Management

- This repository currently has both `package-lock.json` and `pnpm-lock.yaml`.
  Do not add packages or rewrite lockfiles unless the task explicitly requires
  dependency changes.
- For running existing scripts, use `npm` as shown above.
- Do not copy Sub2API's frontend package-manager restriction into this
  repository.

## Sub2API Integration Rules

- Sub2API may call this service as a local process or production sidecar.
- Keep the default API/Web UI port `3000` and Master port `3100` unless the
  current task explicitly changes the integration contract and updates both
  repositories' documentation.
- Do not occupy Sub2API's local backend/frontend ports `18081` and `15174`.
- Production deployment details are controlled by the Sub2API repository docs;
  this repository records only the AIClient2API-side requirements.
- If route paths, API-key behavior, ports, or sidecar assumptions change, update
  both `docs/SUB2API_INTEGRATION.md` here and Sub2API's
  `docs/dev/RELATED_PROJECTS.md`.

## Change Logging

- AIClient2API internal changes go in `docs/CHANGELOG_CUSTOM.md`.
- Cross-repository contract changes must also be recorded in the Sub2API
  repository documentation.
- Do not rewrite old changelog entries only to move them between repositories.

## Coding Notes

- Preserve provider-specific protocol behavior unless the task explicitly
  changes it.
- Keep provider response sanitization and streaming behavior covered by focused
  tests when modifying Kiro or other client-bound providers.
- Do not commit secrets, OAuth credential files, local logs, or generated runtime
  state.
