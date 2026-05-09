# 08 — Cloudflare R2 Media Storage

## Why Use R2 for Media?

Your content lives in Git — that is fine for Markdown files. But committing images and other binary media to Git causes:

- Repository bloat that makes clones and pulls slow over time
- GitHub's 100 MB file limit and 1 GB repo soft-limit becoming a concern
- CI/CD pipelines downloading large blobs on every build

Cloudflare R2 separates media storage from content, keeping the Git repo lean while serving images at the edge via Cloudflare's global CDN.

### Why R2 Over Other Options

| | Cloudflare R2 | AWS S3 | Google Drive |
|---|---|---|---|
| Free storage | 10 GB/mo | 5 GB (12 months only) | 15 GB |
| Egress fees | **None** | $0.09/GB | None |
| Sveltia CMS support | **Native built-in** | Native built-in | Native built-in |
| Already on your stack | **Yes** | No | No |

Since you are already using Cloudflare Workers for your auth proxy and API backends, R2 keeps all infrastructure in one place with one account.

## How the Upload Flow Works

```
Editor's browser → Sveltia CMS UI (enters secret once per session)
                 → PUT request directly to R2 S3-compatible API
                 → R2 stores object in bucket
                 → public_url/filename inserted into content field
```

The secret access key is held in **session memory only** — it is never written to disk, localStorage, or Git.

## One-Time Setup

### 1. Create an R2 Bucket

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **R2 Object Storage → Buckets → Create bucket**
3. Enter a bucket name, e.g. `cms-content-karnataka-media`
   - Must be lowercase, alphanumeric, hyphens only
   - The name will appear in your config.yml and API endpoint
4. Leave the location as **Automatic**
5. Click **Create bucket**

Note your **Account ID** from the right sidebar — you will need it for config.yml and the API endpoint.

### 2. Enable Public Access (r2.dev Domain)

By default the bucket is private. You need a public URL so Hugo and GitHub Pages can display uploaded images.

1. Open your bucket and go to **Settings → Public access**
2. Under **R2.dev subdomain**, click **Allow access**
3. Confirm the warning — this allows anyone to read objects in the bucket
4. You will see a URL like:
   ```
   https://pub-a1b2c3d4e5f6.r2.dev
   ```
5. Copy this URL — it becomes the `public_url` in config.yml

> **Note:** Objects are publicly readable, not writable. Only someone with your secret access key can upload or delete files.

### 3. Create a Scoped API Token

Do not use your global Cloudflare API key. Create a minimal-permission token scoped to this bucket only.

1. Go to **R2 Object Storage → Manage R2 API tokens**
2. Click **Create API token**
3. Fill in:
   - **Token name:** `sveltia-cms-karnataka`
   - **Permissions:** `Object Read & Write`
   - **Specify bucket:** choose `cms-content-karnataka-media` (your specific bucket — not all buckets)
4. Leave **TTL** as No expiry (or set a rotation date if your policy requires it)
5. Click **Create API token**
6. You will see:
   - **Access Key ID** — copy this; it goes in config.yml
   - **Secret Access Key** — copy immediately; it is shown **only once**

Store the secret somewhere secure (e.g. a password manager). Editors will need to paste it into the CMS UI each session.

### 4. Configure CORS on the Bucket

Sveltia CMS uploads directly from the browser. The bucket must allow cross-origin requests from your CMS admin page.

1. Open your bucket and go to **Settings → CORS**
2. Click **Add CORS policy**
3. Paste the following JSON, replacing the origin with your actual admin URL:

```json
[
  {
    "AllowedOrigins": [
      "https://anand-raj.github.io"
    ],
    "AllowedMethods": [
      "GET",
      "PUT",
      "POST",
      "DELETE",
      "HEAD"
    ],
    "AllowedHeaders": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 86400
  }
]
```

4. Click **Save**

> **Security:** Never set `AllowedOrigins` to `["*"]`. Always specify your exact domain. This prevents other sites from using your bucket as an upload endpoint with a stolen secret key.

### 5. Update config.yml

Add the `media_libraries` block to `static/admin/config.yml` in the `cms-content-karnataka` repo:

```yaml
media_libraries:
  cloudflare_r2:
    access_key_id: YOUR_ACCESS_KEY_ID
    bucket: cms-content-karnataka-media
    account_id: YOUR_CLOUDFLARE_ACCOUNT_ID
    public_url: https://pub-a1b2c3d4e5f6.r2.dev
```

Replace all placeholder values with your real values from steps 1–3.

Full `config.yml` context for reference:

```yaml
backend:
  name: github
  repo: anand-raj/cms-content-karnataka
  branch: main
  base_url: https://sveltia-cms-auth.e-anandraj.workers.dev

media_folder: content/articles
public_folder: /articles

site_url: https://anand-raj.github.io/cms-content-karnataka/

media_libraries:
  cloudflare_r2:
    access_key_id: YOUR_ACCESS_KEY_ID
    bucket: cms-content-karnataka-media
    account_id: YOUR_CLOUDFLARE_ACCOUNT_ID
    public_url: https://pub-a1b2c3d4e5f6.r2.dev

collections:
  # ... rest of config unchanged
```

Commit and push this change to `main`. The CMS picks it up on next page load.

## Entering the Secret in Sveltia CMS

The secret access key is **never stored in config or Git**. Editors enter it once per browser session:

1. Visit `https://anand-raj.github.io/cms-content-karnataka/admin/`
2. Log in with GitHub as normal
3. A prompt appears: **Cloudflare R2 — Secret Access Key**
4. Paste the secret access key from step 3
5. Click **Connect**

The key is held in browser session memory and cleared when the tab is closed or the editor logs out.

### Uploading Images When Editing

1. Open any article in the CMS editor
2. Click an **Image** or **File** field
3. Click **Choose image** or drag and drop a file
4. Sveltia CMS uploads directly to R2 in the background
5. The inserted value in the content field will be the full public URL:
   ```
   https://pub-a1b2c3d4e5f6.r2.dev/your-photo.jpg
   ```

Hugo renders this URL directly in `<img>` tags. No further configuration needed.

## Optional: Unsplash Stock Photos Alongside R2

You can configure Sveltia CMS to also let editors search Unsplash for free stock photos, without uploading anything to R2:

```yaml
media_libraries:
  cloudflare_r2:
    access_key_id: YOUR_ACCESS_KEY_ID
    bucket: cms-content-karnataka-media
    account_id: YOUR_CLOUDFLARE_ACCOUNT_ID
    public_url: https://pub-a1b2c3d4e5f6.r2.dev
  stock_assets:
    providers:
      - unsplash
```

In the image picker, editors will see two tabs: **Your uploads** (R2) and **Stock photos** (Unsplash). Unsplash photos are hotlinked — they are not copied to R2.

> **Attribution:** Unsplash's free license requires attribution. Add an `image_caption` field to your collection schemas and make it required when an Unsplash URL is used.

## Security Checklist

Before going live, verify:

- [ ] CORS `AllowedOrigins` is set to your exact domain — not `*`
- [ ] API token is scoped to **this bucket only** — not "All buckets"
- [ ] API token has `Object Read & Write` — not admin or token management permissions
- [ ] Secret access key is stored in a password manager — not in any file or chat
- [ ] `public_url` is the `r2.dev` URL or a custom domain — the S3 API endpoint always requires auth and must not be used as public_url
- [ ] `access_key_id` in config.yml is correct — it is safe to commit
- [ ] The bucket is serving content over HTTPS only

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Upload fails with `403 Forbidden` | Wrong secret or CORS | Re-enter the secret in the CMS UI; check CORS origin matches exactly |
| Upload fails with `CORS error` in browser console | CORS policy missing or wrong origin | Revisit step 4 and check the `AllowedOrigins` value |
| Images not visible after upload | Wrong `public_url` or r2.dev not enabled | Verify the r2.dev subdomain is allowed in bucket settings |
| CMS does not show R2 option | `media_libraries.cloudflare_r2` not in config.yml | Check the YAML indentation — it must be at the top level, not inside `backend` |
| Secret prompt does not appear | `access_key_id` or `account_id` missing | All four fields (`access_key_id`, `bucket`, `account_id`, `public_url`) are required |
