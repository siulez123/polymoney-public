# Security

Never post private keys, seed phrases, API credentials, dashboard tokens, wallet histories or raw server logs in an issue, PR, screenshot or Actions artifact.

For a vulnerability, use GitHub's **Report a vulnerability** action on the repository's Security tab when enabled. If private reporting is unavailable, ask the maintainer for a private contact without including exploit details or credentials in a public issue. There is no promised response SLA.

Use paper mode without wallet credentials for development. Live orders require explicit configuration and environment confirmation. Do not expose the dashboard to the Internet without authentication and HTTPS.

A sanitized summary is not automatically suitable for public release. Review financial figures and infrastructure details as well as secrets. If a real credential was committed, revoke/rotate it; deleting a file or rewriting Git history does not revoke it.

See [public release preparation](docs/public-release.md). No complete historical credential audit has been claimed.
