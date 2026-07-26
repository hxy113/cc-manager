# Contributing to cc-manager

Thank you for improving cc-manager. This project reads and sometimes modifies local AI CLI session files, so correctness and data safety matter more than feature volume.

## Before changing code

1. Read [the development guide](./docs/DEVELOPMENT.md), [architecture](./docs/ARCHITECTURE.md), and [known limitations](./docs/KNOWN_LIMITATIONS.md).
2. Check existing issues and confirm the behavior against current code, not the archived handover document.
3. Do not include raw session files, tokens, credentials, private paths, or conversation content in issues, fixtures, commits, or screenshots.

## Development

```powershell
npm install
npm test
```

Bug fixes require a regression test. Tests should use temporary directories and must not mutate the developer's real Claude or Codex sessions. Scripts that intentionally touch real data require `CC_MANAGER_E2E_ALLOW_REAL_DATA=1` and are not part of normal validation.

## Pull requests

- Keep one logical change per pull request.
- Explain user-visible behavior, failure modes, and rollback concerns.
- Update the current documentation identified in `docs/README.md`.
- Preserve the local-only HTTP boundary and copy-on-write/backup safety invariants.
- Ensure `npm test` passes on both Windows and Linux where the changed feature is intended to work.

Commit subjects use `fix:`, `feat:`, `test:`, `docs:`, or `chore:` followed by a concise description.
