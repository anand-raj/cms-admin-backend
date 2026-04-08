# 04 — Sveltia CMS Setup

## What Is Sveltia CMS?

[Sveltia CMS](https://github.com/sveltia/sveltia-cms) is a fast, drop-in replacement for Netlify/Decap CMS. It runs entirely in the browser and stores content directly in your GitHub repository.

## Step 1 — Create a GitHub OAuth App

> **Important:** Create an **OAuth App**, not a GitHub App. These are different. The wrong type is the most common setup mistake.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps**
   (Direct link: `https://github.com/settings/applications/new`)
2. Fill in:
   - **Application name:** `Sveltia CMS`
   - **Homepage URL:** `https://anand-raj.github.io/cms-hugo-decap/`
   - **Authorization callback URL:** `https://sveltia-cms-auth.e-anandraj.workers.dev/callback`
3. Click **Register application**
4. Copy the **Client ID**
5. Click **Generate a new client secret** and copy the secret immediately

Use the Client ID and secret in your [Cloudflare Worker environment variables](./03-cloudflare-worker.md#3-set-environment-variables).

## Step 2 — Admin Entry Point

`static/admin/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Content Manager</title>
  </head>
  <body>
    <script src="https://unpkg.com/@sveltia/cms/dist/sveltia-cms.js"></script>
  </body>
</html>
```

## Step 3 — CMS Configuration

`static/admin/config.yml`:

```yaml
backend:
  name: github
  repo: anand-raj/cms-hugo-decap      # <username>/<repo>
  branch: main
  base_url: https://sveltia-cms-auth.e-anandraj.workers.dev

media_folder: content/posts           # Where uploaded media is stored in the repo
public_folder: /posts                 # Public URL prefix for served media

site_url: https://anand-raj.github.io/cms-hugo-decap/

collections:
  - name: posts
    label: Posts
    folder: content/posts
    create: true
    path: "{{slug}}/index"
    media_folder: images
    public_folder: images
    fields:
      - { label: Title,         name: title,         widget: string }
      - { label: Date,          name: date,           widget: datetime, format: "YYYY-MM-DDTHH:mm:ssZ" }
      - { label: Last Modified, name: lastmod,        widget: datetime, format: "YYYY-MM-DDTHH:mm:ssZ" }
      - { label: Draft,         name: draft,          widget: boolean,  default: true }
      - { label: Description,   name: description,    widget: string,   required: false }
      - { label: Author,        name: author,         widget: string,   default: Admin }
      - { label: Categories,    name: categories,     widget: list,     required: false }
      - { label: Tags,          name: tags,           widget: list,     required: false }
      - { label: Hero Image,    name: image,          widget: string,   required: false }
      - { label: Image Caption, name: image_caption,  widget: string,   required: false }
      - { label: TOC,           name: toc,            widget: boolean,  default: true }
      - { label: Comments,      name: comments,       widget: boolean,  default: true }
      - { label: Body,          name: body,           widget: markdown }
```

### Key config fields explained

| Field | Description |
|---|---|
| `backend.base_url` | Cloudflare Worker URL (no path suffix) |
| `media_folder` | Repo path where Sveltia uploads images |
| `public_folder` | URL prefix for rendering uploaded images |
| `path: "{{slug}}/index"` | Creates `content/posts/<slug>/index.md` (page bundle) |
| `media_folder: images` (collection) | Post-scoped images go into `content/posts/<slug>/images/` |

### Datetime format gotcha

The `format` value in datetime fields must use **moment.js** syntax, not Go's reference time:

| ❌ Go format (wrong) | ✅ moment.js format (correct) |
|---|---|
| `2006-01-02T15:04:05Z07:00` | `YYYY-MM-DDTHH:mm:ssZ` |

Using Go format causes the literal string `2006-01-02T15:04:05Z07:00` to be written into frontmatter.

## Verifying Setup

1. Push `static/admin/` to `main`
2. Wait for GitHub Actions deploy to complete
3. Visit `https://anand-raj.github.io/cms-hugo-decap/admin/`
4. Click **Login with GitHub**
5. Authorize the OAuth App
6. You should see the Sveltia CMS dashboard with your posts listed

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Redirect loop on login | Wrong callback URL in OAuth App | Must be `<worker-url>/callback` |
| `access_denied` error | Not authorized to the OAuth App | Check **GitHub → Settings → Authorized OAuth Apps** |
| CMS loads but no posts | Wrong `folder` path in config | Must match `content/posts` exactly |
| Images not uploading | Wrong `media_folder` | Confirm repo path exists |
| Token stored but API 401 | Using GitHub App instead of OAuth App | Delete GitHub App, create OAuth App |

### Nuclear reset (clear auth state)

Open browser DevTools → Application → Local Storage → `https://anand-raj.github.io` → delete all keys → reload `/admin/`.
