# Security policy

## Supported version

Security fixes target the latest commit on the `main` branch. The project does not currently maintain multiple supported release lines.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting or a private Security Advisory when available. If no private channel is available, open a minimal public issue asking the maintainer for a private contact method, without including exploit details or sensitive data.

Never attach:

- Claude Code or Codex raw session files;
- GitHub/WebDAV tokens or credentials;
- private source code, personal conversation content, or identifying local paths;
- backup archives containing any of the above.

Include the affected commit, operating system, Node.js version, impact, reproduction prerequisites, and a sanitized proof of concept.

## Security model

cc-manager is a single-user local tool. Its HTTP protection depends on binding to `127.0.0.1`, validating loopback Host headers, and not enabling CORS. It is not designed for LAN, public internet, shared-host, or reverse-proxy deployment.

Session backups contain sensitive conversation and tool-output data. Store Git and WebDAV backups as private data and rotate credentials if they may have appeared in a session or log.
