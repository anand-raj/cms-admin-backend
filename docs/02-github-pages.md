# 02 — GitHub Pages Deployment

## How It Works

On every push to `main`, a GitHub Actions workflow:

1. Checks out the repository
2. Installs Hugo Extended (latest)
3. Runs `hugo --minify` to build the site into `public/`
4. Uploads `public/` as a Pages artifact
5. Deploys to GitHub Pages

## One-Time Setup

### 1. Create the Repository

```bash
git init
git add .
git commit -m "initial commit"
gh repo create cms-hugo-decap --public --source=. --remote=origin --push
# or: git remote add origin https://github.com/<you>/cms-hugo-decap.git && git push -u origin main
```

### 2. Enable GitHub Pages (CRITICAL)

In your repository on GitHub:

1. Go to **Settings → Pages**
2. Under **Source**, select **GitHub Actions** (not "Deploy from a branch")
3. Click **Save**

> **If you skip this step**, the workflow will fail with a permissions error when trying to deploy.

### 3. Set baseURL in hugo.toml

```toml
baseURL = 'https://<username>.github.io/<repo-name>/'
```

Replace `<username>` and `<repo-name>` with your GitHub username and repository name. The trailing slash is required.

## Workflow File

`.github/workflows/deploy.yml`:

```yaml
name: Deploy Hugo site to Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

defaults:
  run:
    shell: bash

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Setup Hugo
        uses: peaceiris/actions-hugo@v3
        with:
          hugo-version: "latest"
          extended: true          # Required for SCSS

      - name: Setup Pages
        id: pages
        uses: actions/configure-pages@v5

      - name: Build with Hugo
        env:
          HUGO_ENVIRONMENT: production
        run: hugo --minify

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./public

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

## After Initial Setup

1. Push to `main` — the workflow runs automatically
2. Go to **Actions** tab in your repo to monitor progress
3. After the deploy job succeeds, your site is live at:
   `https://<username>.github.io/<repo-name>/`

## Subpath Considerations

Because the site is deployed to a subpath (e.g., `/cms-hugo-decap/`), all internal URLs must be relative. Hugo handles this correctly when `baseURL` ends with the subpath.

If you ever need to run the site from root (e.g., a custom domain), update `baseURL` to `https://yourdomain.com/` and remove the subpath.

## Pushing Changes

Sveltia CMS commits directly to `main` when you save a post. Always pull before you push locally to avoid conflicts:

```bash
git pull --rebase
git push
```
