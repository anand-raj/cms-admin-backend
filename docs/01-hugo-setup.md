# 01 — Hugo Project Setup

## Prerequisites

- Hugo Extended (required for SCSS processing)
- Git

Verify Hugo Extended is installed:

```bash
hugo version
# Output should contain "extended"
```

## Project Structure

```
cms-hugo-decap/
├── archetypes/
│   ├── default.md          # Default frontmatter template
│   └── posts.md            # Posts-specific frontmatter template
├── assets/
│   └── scss/
│       └── main.scss       # Site styles (compiled by Hugo Pipes)
├── content/
│   └── posts/
│       └── my-post/        # Page bundle (folder per post)
│           ├── index.md    # Post content
│           └── images/     # Post-scoped images
├── layouts/
│   ├── _default/
│   │   ├── baseof.html     # Base HTML shell
│   │   ├── single.html     # Default single page
│   │   └── list.html       # Default list page
│   ├── index.html          # Home page (featured + grid layout)
│   ├── partials/
│   │   ├── head.html       # <head> with Hugo Pipes + SEO
│   │   ├── header.html     # Site navigation
│   │   ├── footer.html     # Footer with social links
│   │   └── post-image.html # Smart image partial (local + external URLs)
│   ├── posts/
│   │   └── single.html     # Post layout (hero, TOC, byline, prev/next)
│   └── shortcodes/
│       └── img.html        # Responsive image shortcode
├── static/
│   └── admin/              # Sveltia CMS admin panel
│       ├── index.html
│       └── config.yml
├── cloudflare-worker/
│   └── sveltia-cms-auth.js # OAuth worker source (for reference)
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Actions CI/CD
└── hugo.toml               # Site configuration
```

## hugo.toml Configuration

```toml
baseURL = 'https://anand-raj.github.io/cms-hugo-decap/'
languageCode = 'en-us'
title = 'My New Hugo Project'

[params]
  description = "A production-ready Hugo site built with best practices."

  [params.social]
    twitter = "yourtwitterhandle"
    github  = "anand-raj"
```

> **Important:** `baseURL` must match your GitHub Pages URL exactly, including the trailing slash and repo subpath.

## Creating a New Post

Use the posts archetype to scaffold a new post:

```bash
hugo new content/posts/my-post-title/index.md
```

This creates a page bundle at `content/posts/my-post-title/` with pre-filled frontmatter. Add an `images/` folder alongside `index.md` for post-scoped images.

## Frontmatter Fields

```yaml
---
title: "Post Title"
date: 2026-04-07T00:00:00+05:30
lastmod: 2026-04-07T00:00:00+05:30
draft: true                          # Set to false to publish
description: "One-line SEO summary"
author: "Admin"
categories: ["Tech"]
tags: ["hugo", "jamstack"]
image: "images/hero.jpg"             # Local bundle image OR Unsplash URL
image_caption: "Photo by [Name](url) on [Unsplash](https://unsplash.com)"
toc: true                            # Show table of contents
comments: true
---
```

## Hugo Pipes (SCSS)

The `<head>` partial processes SCSS at build time:

```go
{{ $opts := dict "targetPath" "css/main.css" "enableSourceMap" (not hugo.IsProduction) }}
{{ $style := resources.Get "scss/main.scss" | toCSS $opts | minify | fingerprint }}
<link rel="stylesheet"
      href="{{ $style.RelPermalink }}"
      integrity="{{ $style.Data.Integrity }}"
      crossorigin="anonymous">
```

This compiles `assets/scss/main.scss` → minified CSS → fingerprinted filename → SRI hash.

## Image Handling

The `post-image` partial handles three image types:

| Type | Example | Processing |
|---|---|---|
| Local bundle (raster) | `images/hero.jpg` | Hugo Pipes resize + WebP |
| Local bundle (SVG) | `images/logo.svg` | Served as-is |
| External URL | `https://images.unsplash.com/...` | Served as-is |

## Running Locally

```bash
# Include draft posts
hugo server -D

# Production preview
hugo server
```

Site available at `http://localhost:1313/cms-hugo-decap/`
