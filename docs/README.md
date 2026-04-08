# cms-hugo-decap — Documentation

This site is a production-ready Hugo blog deployed to GitHub Pages with Sveltia CMS as the editorial interface. Content is stored as Markdown in Git — no database, no server.

## Architecture

```
Editor → Sveltia CMS (/admin/)
              ↓
    Cloudflare Worker (OAuth proxy)
              ↓
         GitHub OAuth
              ↓
    Sveltia commits Markdown to repo
              ↓
    GitHub Actions triggers Hugo build
              ↓
    Site deploys to GitHub Pages
```

## Stack

| Layer | Technology |
|---|---|
| Static site generator | Hugo Extended |
| Hosting | GitHub Pages |
| CI/CD | GitHub Actions |
| CMS | Sveltia CMS |
| OAuth proxy | Cloudflare Workers |
| Styles | SCSS via Hugo Pipes |
| Images | Unsplash CDN + Hugo Pipes (local) |

## Documentation Index

| File | Topic |
|---|---|
| [01-hugo-setup.md](01-hugo-setup.md) | Hugo project structure and theme setup |
| [02-github-pages.md](02-github-pages.md) | Deploying to GitHub Pages with GitHub Actions |
| [03-cloudflare-worker.md](03-cloudflare-worker.md) | Setting up the OAuth proxy on Cloudflare Workers |
| [04-sveltia-cms.md](04-sveltia-cms.md) | Configuring Sveltia CMS |
| [05-editorial-workflow.md](05-editorial-workflow.md) | Day-to-day editorial workflow |
| [06-user-access.md](06-user-access.md) | Granting and revoking CMS access |
| [07-cost-considerations.md](07-cost-considerations.md) | Free-tier limits, cost at scale, platform alternatives |

## Live URLs

- **Site:** https://anand-raj.github.io/cms-hugo-decap/
- **CMS:** https://anand-raj.github.io/cms-hugo-decap/admin/
- **Repository:** https://github.com/anand-raj/cms-hugo-decap
