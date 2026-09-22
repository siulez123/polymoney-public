# Public source release

This repository is a source-only distribution of the core TypeScript bot and research tools. It starts with clean Git history and does not include operational trade histories, journals, private server configuration, wallet addresses, production workflows or credentials. Mobile clients and the experimental Rust sidecar are outside this release.

## Scope of verification

The release was reviewed on 2026-09-22. Only files in public-release-manifest.json are distributed. Configuration is a paper-mode example, wallet credentials are empty and the dashboard binds to localhost. The release was scanned locally with detect-secrets 1.5.0 (network verification disabled) and an additional review of wallet addresses, hostnames and credential patterns. A synthetic redaction-test fixture is explicitly allowlisted; no real credentials were identified in the release. Source, export tests, type checking, secret scanning and builds are verified in CI. Research results do not establish profitable live execution.

This review covers this source distribution. It is not an audit of the private operational repository's historical commits, and those commits are not imported here. Secret detection has false negatives; use private vulnerability reporting for any suspected disclosure.

## Reproduce the distribution

```bash
python3 scripts/export_public.py --output /tmp/polymoney-source
cd /tmp/polymoney-source
npm ci
npm run typecheck
npm test
python3 -m unittest discover -s scripts -p 'test_*.py'
npm run build
```

The exporter copies only the explicit manifest, rejects symlinks and private paths, and refuses existing output directories. It maps config.example.yaml to config.yaml. Never add local environment files, operational data, secrets or production infrastructure workflows to the manifest.

## Licensing

No repository-wide reuse license has been granted in this release. Public availability is not an MIT or other open-source license. Dependency licenses remain with their respective owners. A future repository license requires an explicit maintainer decision.

## Local setup

Use Node.js 24+. Copy .env.example to .env and config.example.yaml to config.local.yaml. Start with CONFIG_PATH=config.local.yaml npm run dev. Paper mode requires no wallet credentials. Configure authentication and HTTPS before allowing remote dashboard access.
