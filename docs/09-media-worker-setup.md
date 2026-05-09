# 09 — Media Worker Setup (Cloudflare Workers + R2)

This guide walks through setting up the `cms-media` Cloudflare Worker end-to-end, including the R2 bucket, public access, CORS, D1 binding, and deployment. The Worker acts as a secure upload proxy so that browser clients never need direct R2 API credentials.

---

## Architecture Overview

```
Admin portal (browser)
  │  POST /media/upload   (multipart, Authorization: token <github-token>)
  │  GET  /media          (list)
  │  DELETE /media/:key
  ▼
cms-media Worker  (Cloudflare Workers)
  │  validates GitHub token → D1 admins table
  │  writes / reads / deletes via R2 binding (no S3 credentials exposed)
  ▼
R2 bucket  (cms-media-karnataka)
  │  stores objects as  YYYY/MM/filename
  ▼
Public R2 URL  (https://pub-xxxx.r2.dev/YYYY/MM/filename)
  ▼
Hugo site / anywhere that references the URL
```

**Why proxy through a Worker instead of direct R2 S3 API?**

Direct R2 uploads from the browser require exposing an S3 Access Key Secret to the client.  The Worker approach keeps credentials server-side, adds auth (GitHub token → D1 role check), enforces file-type and size limits, and eliminates R2 CORS configuration complexity.

---

## Prerequisites

- Cloudflare account (free tier is sufficient)
- Node.js ≥ 18 and npm installed locally
- Wrangler CLI: `npm install -g wrangler`  (or use `npx wrangler`)
- An existing D1 database called `cms` with an `admins` table  
  (see [03-cloudflare-worker.md](03-cloudflare-worker.md) and [06-user-access.md](06-user-access.md))
- The `cms-backend` repository cloned locally

---

## Step 1 — Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser window. Authorise Wrangler to access your Cloudflare account.  After logging in, verify the CLI can see your account:

```bash
npx wrangler whoami
```

> **macOS corporate / VPN users:** If wrangler fails with SSL errors, export your system CA bundle first:
> ```bash
> security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain \
>   > /tmp/system-certs.pem
> export NODE_EXTRA_CA_CERTS=/tmp/system-certs.pem
> ```
> Prefix every `wrangler` command with `NODE_EXTRA_CA_CERTS=/tmp/system-certs.pem`.

---

## Step 2 — Create the R2 Bucket

### Option A — Cloudflare Dashboard

1. Go to **R2 Object Storage → Buckets → Create bucket**
2. Name: `cms-media-karnataka` (lowercase, alphanumeric, hyphens only)
3. Location: **Automatic**
4. Click **Create bucket**

### Option B — Wrangler CLI

```bash
npx wrangler r2 bucket create cms-media-karnataka
```

Verify it was created:

```bash
npx wrangler r2 bucket list
```

---

## Step 3 — Enable Public Access (r2.dev domain)

Objects must be publicly readable so Hugo pages and other consumers can display media without authentication.

1. Open the bucket in the dashboard
2. Go to **Settings → Public access → R2.dev subdomain**
3. Click **Allow access** and confirm the warning
4. Copy the URL shown, e.g.:
   ```
   https://pub-ef2e502c5f7c4d6d992c8d7758c43027.r2.dev
   ```

This value goes into `R2_PUBLIC_URL` in `wrangler.toml` and into the admin portal's `MEDIA_WORKER_URL` config.

> Objects are **publicly readable** but not writable. Only requests authenticated through the Worker can upload or delete files.

---

## Step 4 — Configure R2 CORS (for direct browser reads)

CORS is only needed for cross-origin *reads* (e.g. the admin portal loading thumbnail images from the r2.dev domain).  Uploads go through the Worker — no browser-to-R2 CORS needed for that.

1. Open the bucket → **Settings → CORS**
2. Click **Add CORS policy** and paste:

```json
[
  {
    "AllowedOrigins": [
      "https://admin-portal-93k.pages.dev",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

Replace `https://admin-portal-93k.pages.dev` with your actual admin portal URL.

> **Security:** Never use `"AllowedOrigins": ["*"]`. Always list exact origins.

---

## Step 5 — Find Your D1 Database ID

The Worker re-uses the existing `cms` D1 database for auth.  Get its ID:

```bash
npx wrangler d1 list
```

Note the `database_id` UUID for the database named `cms`.

---

## Step 6 — Create the Worker Project

```bash
mkdir cloudflare-media-worker
cd cloudflare-media-worker
```

Create `wrangler.toml`:

```toml
name              = "cms-media"
main              = "index.js"
compatibility_date = "2025-01-01"

[vars]
SITE_URL      = "https://your-site.github.io"
ADMIN_URL     = "https://your-admin-portal.pages.dev"
R2_PUBLIC_URL = "https://pub-xxxx.r2.dev"

[[d1_databases]]
binding       = "DB"
database_name = "cms"
database_id   = "YOUR_D1_DATABASE_ID"

[[r2_buckets]]
binding     = "MEDIA_BUCKET"
bucket_name = "cms-media-karnataka"
```

Replace all placeholder values:

| Placeholder | Where to find it |
|---|---|
| `SITE_URL` | Your Hugo site's public URL |
| `ADMIN_URL` | Your admin portal URL (Cloudflare Pages) |
| `R2_PUBLIC_URL` | Copied in Step 3 |
| `YOUR_D1_DATABASE_ID` | From Step 5 |
| `bucket_name` | The bucket name from Step 2 |

---

## Step 7 — Add the Worker Code

Copy `cloudflare-media-worker/index.js` from this repository into your project directory. The Worker provides these endpoints:

| Method | Path | Auth required | Description |
|---|---|---|---|
| `GET` | `/media` | Any admin role | List all objects (key, size, upload date, public URL) |
| `POST` | `/media/upload` | Any admin role | Upload a file (multipart `file` field) |
| `DELETE` | `/media/:key` | owner or moderator | Delete an object by key |
| `OPTIONS` | `*` | None | CORS preflight |

### Key behaviours

- **Auth:** Every request must include `Authorization: token <github-token>`. The Worker hashes the token, checks GitHub's `/user` API, then looks up the login in `D1.admins`. Results are cached in Cloudflare's edge cache for 5 minutes to avoid repeated GitHub API calls.
- **File validation:** Extension and MIME type must both be in the allow-list (jpg, png, webp, gif, avif, svg, mp4, webm, pdf).
- **File name sanitisation:** Path separators and non-safe characters are replaced with underscores; name truncated to 200 chars.
- **Size limit:** 1 MB maximum enforced server-side (HTTP 413 if exceeded).
- **Key format:** Objects are stored as `YYYY/MM/sanitised-filename`, e.g. `2026/05/photo.jpg`.  This allows the admin portal to filter by month.

---

## Step 8 — Deploy the Worker

```bash
cd cloudflare-media-worker
npx wrangler deploy
```

Wrangler will print the deployed URL:

```
https://cms-media.<your-subdomain>.workers.dev
```

Verify the D1 and R2 bindings are listed in the deployment summary output.

To redeploy after changes:

```bash
npx wrangler deploy
```

---

## Step 9 — Configure the Admin Portal

In `admin-portal/src/lib/config.js` set:

```js
export const MEDIA_WORKER_URL = 'https://cms-media.<your-subdomain>.workers.dev';
```

The admin portal's `api.js` functions (`getMedia`, `uploadMedia`, `deleteMedia`) all call this base URL with the user's GitHub token in the `Authorization` header.

---

## Step 10 — Verify Everything Works

### List media (should return empty array initially)

```bash
curl -H "Authorization: token YOUR_GITHUB_TOKEN" \
  https://cms-media.<your-subdomain>.workers.dev/media
```

Expected response:
```json
{"objects":[],"truncated":false,"cursor":null}
```

### Upload a test file

```bash
curl -X POST \
  -H "Authorization: token YOUR_GITHUB_TOKEN" \
  -F "file=@/path/to/test.jpg" \
  https://cms-media.<your-subdomain>.workers.dev/media/upload
```

Expected response:
```json
{"publicUrl":"https://pub-xxxx.r2.dev/2026/05/test.jpg","key":"2026/05/test.jpg"}
```

### Verify the file is publicly readable

```bash
curl -I https://pub-xxxx.r2.dev/2026/05/test.jpg
```

Expected: `HTTP/2 200`

### Delete the test file

```bash
curl -X DELETE \
  -H "Authorization: token YOUR_GITHUB_TOKEN" \
  "https://cms-media.<your-subdomain>.workers.dev/media/2026%2F05%2Ftest.jpg"
```

Expected response:
```json
{"deleted":"2026/05/test.jpg"}
```

---

## CORS in the Worker

The Worker handles CORS internally — no Cloudflare dashboard CORS rule is needed for uploads. `SITE_URL`, `ADMIN_URL`, and `http://localhost:5173` are whitelisted. All `OPTIONS` preflight requests return `204` with the appropriate headers.

If you add additional origins (e.g. a staging portal), update `corsHeaders()` in `index.js` and redeploy.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` | GitHub token invalid or expired | Re-login in admin portal; check token isn't cached stale (cache TTL is 5 min) |
| `403 Forbidden` on DELETE | User role is `editor` or `viewer` | Only `owner` / `moderator` can delete; check the `admins` table |
| `400 File type not allowed` | Extension or MIME type not in allow-list | Add to `ALLOWED_EXTENSIONS` and `ALLOWED_CONTENT_TYPES` in `index.js` and redeploy |
| `413` on upload | File is larger than 1 MB | Compress the file before uploading |
| Images load in portal but broken on site | `R2_PUBLIC_URL` mismatch | Ensure `R2_PUBLIC_URL` in wrangler.toml exactly matches the bucket's r2.dev URL |
| Wrangler SSL errors on macOS | Corporate CA bundle | Set `NODE_EXTRA_CA_CERTS=/tmp/system-certs.pem` (see Step 1) |
| `D1_ERROR` in worker logs | Wrong `database_id` | Run `wrangler d1 list` and update wrangler.toml |
| `NoSuchBucket` binding error | `bucket_name` typo in wrangler.toml | Must exactly match the bucket name in the dashboard |

### View live logs

```bash
npx wrangler tail cms-media
```

This streams real-time logs from the deployed Worker, useful for debugging auth failures or unexpected errors.

---

## Updating the Worker

After editing `index.js`:

```bash
cd cloudflare-media-worker
npx wrangler deploy
```

Changes are live within seconds. No downtime.

---

## Cost Considerations

All usage in this project falls within Cloudflare's free tier:

| Resource | Free allowance | Typical usage |
|---|---|---|
| Workers requests | 100,000 / day | Tens of uploads/day |
| R2 storage | 10 GB / month | Images are small |
| R2 Class A ops (writes) | 1,000,000 / month | One per upload |
| R2 Class B ops (reads) | 10,000,000 / month | Listing + portal reads |
| R2 egress | **Free** (no egress fees) | Public URL reads |
| D1 reads | 5,000,000 / day | Auth checks (cached 5 min) |

See [07-cost-considerations.md](07-cost-considerations.md) for the full cost breakdown across all services.
