# 03 — Cloudflare Worker OAuth Proxy

## Why Is This Needed?

A CMS that runs entirely in the browser can't safely store a GitHub OAuth **client secret** in the frontend code. To complete the OAuth flow, a server-side proxy is required.

The Cloudflare Worker acts as that proxy:

```
Browser → GitHub OAuth authorize
GitHub → redirect to Worker /callback with ?code=...
Worker → exchange code for access token (using client secret)
Worker → post token back to browser via postMessage
Browser → Sveltia CMS stores token and accesses GitHub API directly
```

## One-Time Setup

### 1. Create a Cloudflare Account

Sign up at [dash.cloudflare.com](https://dash.cloudflare.com). No credit card required for the free tier.

### 2. Create a Worker

1. In the dashboard, go to **Workers & Pages → Create**
2. Choose **Create Worker**
3. Give it a name (e.g., `sveltia-cms-auth`)
4. Click **Deploy** to create it with the default hello-world script
5. Click **Edit code**
6. Replace the entire contents with the code from `cloudflare-worker/sveltia-cms-auth.js` in this repo
7. Click **Deploy**

Your worker URL will be:
```
https://sveltia-cms-auth.<your-subdomain>.workers.dev
```

### 3. Set Environment Variables

In the worker's **Settings → Variables and Secrets** panel, add:

| Variable | Value | Type |
|---|---|---|
| `GITHUB_CLIENT_ID` | Your GitHub OAuth App client ID | Plain text |
| `GITHUB_CLIENT_SECRET` | Your GitHub OAuth App client secret | **Encrypted** |
| `ALLOWED_DOMAINS` | `anand-raj.github.io` | Plain text |

> **Security:** Always set `GITHUB_CLIENT_SECRET` as an encrypted secret (not plain text). `ALLOWED_DOMAINS` restricts which sites can use this worker.

Click **Save and deploy** after adding variables.

## Worker Endpoints

| Endpoint | Purpose |
|---|---|
| `/auth` | Redirects browser to GitHub OAuth authorize URL |
| `/callback` | Receives `code` from GitHub, exchanges for token, posts to parent window |

## Testing the Worker

Visit `https://sveltia-cms-auth.<your-subdomain>.workers.dev/auth` in a browser. You should be redirected to a GitHub authorization page. If you see an error page, check that environment variables are set.

## Worker Source

The full source is kept at `cloudflare-worker/sveltia-cms-auth.js` in this repository. This file is **reference only** — the live code runs on Cloudflare. Update the deployed worker manually if you make changes.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 403 Forbidden after OAuth | `ALLOWED_DOMAINS` mismatch | Set to exact hostname, no protocol, no trailing slash |
| `invalid_client` from GitHub | Wrong client ID or secret | Re-check OAuth App credentials |
| Token never reaches browser | `postMessage` blocked | Check browser console for CORS/CSP errors |
| Worker returns 500 | Missing env vars | Verify all three variables are deployed |
