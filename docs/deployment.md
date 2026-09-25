# API authentication configuration

Provide the following environment secrets to every API instance:

```text
PLATFORM_JWT_ACCESS_SECRET
PLATFORM_JWT_REFRESH_SECRET
TENANT_JWT_ACCESS_SECRET
TENANT_JWT_REFRESH_SECRET
AUTH_LOGIN_BUCKET_HASH_SECRET
```

Each secret must be at least 32 bytes and all five values must be distinct.
Generate values with a cryptographically secure random generator and store them
in the deployment secret manager; do not commit them or print them in logs. For
example, generate one candidate with PowerShell:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Access tokens default to 900 seconds and refresh tokens to 2,592,000 seconds.
Configure `AUTH_ACCESS_TOKEN_TTL_SECONDS` (maximum 3,600),
`AUTH_REFRESH_TOKEN_TTL_SECONDS` (maximum 7,776,000),
`AUTH_LOGIN_MAX_ATTEMPTS` (default 5), and `AUTH_LOGIN_WINDOW_SECONDS` (default
900) according to the deployment policy.

Keep `AUTH_LOGIN_BUCKET_HASH_SECRET` stable while any login-rate window is
active. Rotating it earlier changes the HMAC key for account/IP bucket IDs and
makes existing counters unreachable. The rate limiter uses PostgreSQL as its
only source of truth; Redis is not required for login correctness. If the
security-domain PostgreSQL database is unavailable, login fails closed with a
structured HTTP 503 response.

Apply the additive Master migration before enabling platform login. Tenant auth
tables are applied by the existing tenant provisioning migration runner. Never
edit an already applied migration; use a new migration for subsequent schema
changes.
