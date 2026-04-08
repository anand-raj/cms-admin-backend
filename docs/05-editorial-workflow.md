# 05 — Editorial Workflow

## Accessing the CMS

Go to `https://anand-raj.github.io/cms-hugo-decap/admin/`

Click **Login with GitHub**. You'll be redirected to GitHub to authorize the OAuth App, then back to the CMS dashboard.

## Creating a New Post

1. Click **New post** (or select **Posts → New post**)
2. Fill in the fields:

| Field | Tips |
|---|---|
| **Title** | Used to generate the post slug/URL |
| **Date / Last Modified** | Auto-filled to now; adjust if needed |
| **Draft** | Keep `true` until ready to publish |
| **Description** | One-line summary for SEO and post cards |
| **Author** | Defaults to `Admin` |
| **Categories / Tags** | Type a value and press Enter to add |
| **Hero Image** | Path to a local image OR full Unsplash URL |
| **Image Caption** | Attribution text shown below hero image |
| **TOC** | Toggle table of contents sidebar |
| **Body** | Rich-text markdown editor |

3. Click **Save** — Sveltia commits directly to `main`
4. GitHub Actions runs automatically (~60 seconds)
5. After the workflow completes, the post is live

## Publishing a Draft

Open the post → toggle **Draft** to `false` → Save. The workflow re-runs and the post becomes publicly visible.

## Using Unsplash Images

Sveltia's image field accepts full external URLs. To get a reliable Unsplash image URL:

1. Find a photo on [unsplash.com](https://unsplash.com)
2. Right-click the photo → **Copy Image Address**  
   (Do **not** use the page URL — the CDN image address is different)
3. Append quality params: `?w=1200&fm=webp&q=80`

Example:
```
https://images.unsplash.com/photo-1600267165477-6d4cc741b379?w=1200&fm=webp&q=80
```

Always add image attribution in **Image Caption** per the Unsplash license.

## How Commits Work

When you save from Sveltia CMS:

- Sveltia pushes a commit directly to `main`
- GitHub Actions detects the push and starts a new build
- The build takes ~30–60 seconds
- The deploy job publishes the updated site

You can monitor deploys in the **Actions** tab of your GitHub repository.

## Editing Existing Posts

1. In the CMS dashboard, click **Posts**
2. Find the post and click it
3. Make edits
4. Click **Save**

## Deleting a Post

In the CMS post list, click the three-dot menu → **Delete**. This commits a file deletion to `main`, which triggers a rebuild.

## Pushing Local Changes

If you edit files locally (layouts, SCSS, config), always pull first because Sveltia may have pushed commits ahead of you:

```bash
git pull --rebase
git push
```

If `git push` is rejected, run `git pull --rebase` again and retry.

## Deploy Timeline

```
Save in CMS
    ↓  (immediate commit to main)
GitHub Actions triggered
    ↓  (~20s — checkout + hugo build)
Artifact uploaded
    ↓  (~10s)
Deployed to GitHub Pages
    ↓
Live at https://anand-raj.github.io/cms-hugo-decap/
```

Total: approximately 30–90 seconds from save to live.
