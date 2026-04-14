# Cost Considerations

This document covers the cost profile of every platform used in this stack, free-tier limits that matter in practice, and evaluated alternatives.

---

## Current Stack at a Glance

| Platform | Role | Pricing Model |
|---|---|---|
| GitHub Pages | Static site hosting | Free (public repos) |
| GitHub Actions | CI/CD build pipeline | Free (public repos) |
| Sveltia CMS | Editorial UI | Free (open source) |
| Cloudflare Workers | OAuth proxy, membership, book orders | Free tier + usage |
| Cloudflare D1 | SQLite database (members, orders) | Free tier + usage |
| Resend | Transactional email | Free tier + usage |
| Razorpay | Payment processing | Transaction fee only |

---

## Platform-by-Platform Breakdown

### GitHub Pages + Actions

| Limit | Free (public repo) | Free (private repo) |
|---|---|---|
| Bandwidth | 100 GB/month soft | 100 GB/month soft |
| Build minutes | Unlimited | 2,000 min/month |
| Storage | 1 GB repo soft limit | 1 GB repo soft limit |
| Sites | 1 user/org site + project sites | Same |

**Cost:** $0 for a public repository. A private repo consumes Actions minutes; a Hugo build typically takes 30–60 seconds, so 2,000 minutes ≈ 2,000–4,000 deploys/month — effectively unlimited for editorial use.

**When you'd pay:** Never for this use case, unless you move to GitHub Enterprise ($21/user/month).

---

### Cloudflare Workers

| Metric | Free | Paid (Workers Paid, $5/month) |
|---|---|---|
| Requests | 100,000/day across all workers | 10M/month included, then $0.30/M |
| CPU time | 10 ms per invocation | 30 s per invocation |
| Workers deployed | 100 | 500 |
| Subrequests (fetch) | 50/request | 1,000/request |

**This project uses 2 workers** (`cms-membership`, `cms-books`) plus a third OAuth proxy worker. All share the 100K/day quota.

**In practice:**
- Membership sign-ups, approve/reject, newsletter sends, and book orders are all low-frequency events for a small site.
- 100K requests/day = ~69 requests/minute continuously — very unlikely to hit this.
- The 10 ms CPU limit is the more realistic constraint: the Razorpay Sig V4 and D1 queries are fast, but a newsletter batch to 100 members makes 100 subrequests to Resend — within the 50 subrequest limit per invocation only because the batch API sends them in one call.

**When you'd upgrade:** Exceeding 100K req/day (viral traffic) or needing longer CPU time for complex processing. $5/month buys 10M requests — sufficient for a medium-traffic site.

---

### Cloudflare D1

| Metric | Free | Paid (Workers Paid) |
|---|---|---|
| Storage | 5 GB total | 5 GB included, then $0.75/GB/month |
| Reads | 5M rows/day | 25B rows/month included |
| Writes | 100K rows/day | 50M rows/month included |

**This project:** One D1 database shared between both workers (`members` and `orders` + `books` tables). Row counts stay in the hundreds for a small site — comfortably within free limits indefinitely.

**When you'd pay:** Only at significant scale (tens of thousands of members, millions of orders).

---

### Resend

| Metric | Free | Pro ($20/month) | Business (custom) |
|---|---|---|---|
| Emails/month | 3,000 | 50,000 | 100,000+ |
| **Emails/day** | **100** | Unlimited | Unlimited |
| Domains | 1 | Unlimited | Unlimited |
| API calls/month | Unlimited | Unlimited | Unlimited |
| Logs retention | 1 day | 3 days | 7 days |

**Critical free-tier constraint: the 100 emails/day cap.**

Emails sent per event in this project:

| Event | Emails |
|---|---|
| Member subscribes | 1 (admin notification) |
| Member approved | 1 (welcome to member) |
| Book order paid | 2 (buyer + admin) |
| Newsletter blast | 1 × number of approved members |

A newsletter to 101+ approved members will silently fail mid-send on the free plan. The code currently logs the error but returns a partial count — recipients beyond 100 are dropped with no retry.

**Production recommendation:** Either upgrade to Pro ($20/month) or route through your own AWS SES account using Resend's "Send with Amazon SES" feature (see below).

---

### Razorpay

Razorpay has no monthly fee. Costs are purely per-transaction:

| Transaction type | Fee |
|---|---|
| Domestic cards, UPI, wallets | 2% per transaction |
| International cards | 3% per transaction |
| Minimum fee | ₹0 (no floor) |
| Settlement | T+2 days |

**Example:** A ₹499 book sale costs ₹9.98 in fees. No platform fee, no monthly minimum.

**When you'd re-evaluate:** At very high volume (thousands of orders/month), a payment aggregator with negotiated rates or direct bank integration becomes worthwhile. Below that threshold, Razorpay is the lowest-friction option for INR payments.

---

## The Resend Daily Cap — Mitigations

Because the 100 emails/day limit affects reliability, here are the evaluated options:

### Option 1: Upgrade Resend to Pro — $20/month

Simplest path. No code or architecture changes. Removes the daily cap and gives unlimited domains.

**Best for:** Sites that grow beyond ~50 newsletter subscribers or expect regular book orders.

### Option 2: Resend + AWS SES ("Send with Amazon SES")

Resend acts as the API layer but routes mail through your **own** AWS SES account. Your Workers code is completely unchanged — same `fetch('https://api.resend.com/emails', ...)`, same Bearer token.

```
Your Worker  →  Resend API  →  Your AWS SES account  →  Recipient
```

**Setup:**
1. Verify a domain in SES and request sandbox exit (AWS console, one-time, ~24h review)
2. Create an IAM user with only `ses:SendRawEmail` permission
3. In Resend dashboard → Domains → "Send with Amazon SES" → enter IAM credentials
4. Update `FROM_EMAIL` env var to your verified domain

**Cost:**
- AWS SES: first 62,000 emails/month free (12-month free tier), then $0.10/1,000
- No daily cap
- Resend free plan remains usable as the API gateway

**Best for:** Projects that want to avoid a monthly Resend subscription while staying on the simple Bearer-token API. The trade-off is AWS account management and the SES sandbox exit process.

### Option 3: Call AWS SES directly (no Resend)

Replace the `sendEmail` helper to call the SES v2 REST API directly from Workers. Eliminates Resend entirely.

**What changes:** Both workers need a ~70-line AWS Signature Version 4 signing function (using `crypto.subtle`, already available in Workers). No npm packages — Workers have no raw TCP so SES SMTP is not usable.

**Cost:** Identical to Option 2 for SES, minus any Resend subscription.

**Best for:** Teams comfortable with AWS, wanting to remove the Resend dependency entirely.

### Option 4: Postmark

| Metric | Free (developer) | Basic ($15/month) |
|---|---|---|
| Emails | 100/month (not per day) | 10,000/month |
| Daily cap | None | None |
| API style | Bearer token (similar to Resend) | Same |

Postmark has no daily cap on any tier, but the free allowance is only 100 total emails (not per day) — useful for development only. Paid starts at $15/month for 10K emails.

**Best for:** Teams who prioritise deliverability and detailed bounce analytics over cost. More expensive than SES at volume.

### Option 5: Brevo (formerly Sendinblue)

| Metric | Free | Starter ($9/month) |
|---|---|---|
| Emails/day | **300** | Unlimited |
| Emails/month | 9,000 | 5,000 (then $0.001/email) |
| Daily cap | 300 | None |

The free tier's 300/day cap is 3× Resend's, and the monthly allowance is 3× larger. API style is similar (REST + API key, no Sig V4).

**Best for:** Tight budgets that need slightly more headroom than Resend free without paying $20/month. Not a long-term solution for newsletter growth.

---

## Alternatives to the Whole Stack

### Netlify + Netlify Functions

| Feature | Free | Pro ($19/month) |
|---|---|---|
| Hosting bandwidth | 100 GB/month | 400 GB/month |
| Serverless function invocations | 125K/month | 2M/month |
| Build minutes | 300/month | 1,000/month |
| Forms | 100 submissions/month | 1,000 submissions/month |

Netlify Identity (for CMS auth) is free up to 1,000 active users. However, Netlify Functions replace Cloudflare Workers but have a much lower free invocation count (125K/month vs 3M/month for Cloudflare). No built-in SQL database — you'd need an external DB like Supabase or PlanetScale.

**Best for:** Teams already on the Netlify ecosystem who don't need D1's SQL storage.

### Vercel + Edge Functions

Similar to Netlify. The free hobby tier bans commercial use. Edge Functions are fast but the free tier limits are aggressive (100K function invocations/day). No built-in database.

**Not suitable** for this use case (commercial book sales + membership) on the free tier.

### Supabase (database alternative to D1)

| Metric | Free | Pro ($25/month) |
|---|---|---|
| Database | 500 MB | 8 GB |
| API requests | Unlimited | Unlimited |
| Edge Functions | 500K invocations/month | 2M/month |
| Auth | Built-in | Built-in |
| Pausing | After 1 week inactive | Never |

The free tier project **pauses after 1 week of inactivity** — a critical issue for a low-traffic site. D1 never pauses.

**Best for:** Projects that need row-level security, realtime subscriptions, or built-in auth. Overkill and risky (pausing) for this use case.

### PlanetScale / Turso (database alternatives)

- **Turso** (libSQL): 9 GB free, 1B row reads/month, no pausing. A viable D1 alternative if you ever move off Cloudflare, but adds latency from a non-Workers environment.
- **PlanetScale**: Free tier eliminated in 2024. Starts at $39/month.

---

## Cost Summary at Different Traffic Levels

### Small site (< 500 members, < 50 book orders/month)

| Platform | Cost |
|---|---|
| GitHub Pages + Actions | $0 |
| Cloudflare Workers + D1 | $0 |
| Resend | $0 (watch 100/day cap) |
| Razorpay | ~₹500 in fees (2% of sales) |
| **Total** | **$0 + payment fees** |

### Medium site (500–5,000 members, 100–500 book orders/month)

| Platform | Cost |
|---|---|
| GitHub Pages + Actions | $0 |
| Cloudflare Workers + D1 | $5/month (Workers Paid) |
| Resend Pro or SES | $20/month or ~$0.50/month (SES) |
| Razorpay | ~₹5,000–₹25,000 in fees |
| **Total** | **$5–25/month + payment fees** |

### Large site (5,000+ members, 500+ orders/month)

At this scale, negotiate Razorpay rates, consider Cloudflare Workers Paid at $5/month (still sufficient — 10M req/month included), and use SES directly at $0.10/1,000 emails. Total platform cost remains under $30/month excluding payment fees.

---

## Recommendations

1. **Start on the full free tier** using `MOCK_PAYMENTS=true` and `FROM_EMAIL=onboarding@resend.dev` for development.
2. **Before launching**, verify a domain in Resend and request SES sandbox exit if going the SES route.
3. **Add the newsletter guard** (return an error if subscriber count > 100) to prevent silent partial delivery on the Resend free plan.
4. **Upgrade Resend to Pro ($20/month) or enable SES routing** before your first newsletter send to a real list.
5. **Cloudflare Workers Paid ($5/month)** is the only other likely upgrade, and only if you scale past 100K daily requests.

---

## Monthly Cost Estimation — Current Setup

_Last updated: April 2026_

### Complete Service Inventory

| Layer | Service | Purpose |
|---|---|---|
| Static site hosting | GitHub Pages | Hugo site at `anand-raj.github.io` |
| CI/CD | GitHub Actions | Hugo build + deploy on push |
| CMS UI | Sveltia CMS (self-hosted) | Editorial interface on `/admin` |
| Admin portal | Cloudflare Pages | React portal at `admin-portal-93k.pages.dev` |
| API Workers | Cloudflare Workers (3 workers) | Membership, Books, OAuth proxy |
| Database | Cloudflare D1 (SQLite) | Members, books, orders, events |
| Email | Resend | Transactional email + newsletter |
| Payments | Razorpay | Book order processing |
| Auth | GitHub OAuth | Admin and CMS authentication |

### Fixed Monthly Platform Costs

| Service | Plan | Monthly Cost |
|---|---|---|
| GitHub Pages | Free (public repo) | **₹0** |
| GitHub Actions | Free (public repo) | **₹0** |
| Sveltia CMS | Open source | **₹0** |
| Cloudflare Workers | Free tier | **₹0** |
| Cloudflare D1 | Free tier | **₹0** |
| Cloudflare Pages | Free tier | **₹0** |
| Resend | Free tier | **₹0** |
| Razorpay | No monthly fee | **₹0** |
| **Total** | | **₹0 / month** |

### Variable Costs (Per-Transaction)

| Event | Cost | Notes |
|---|---|---|
| Book sale — ₹499 | ₹9.98 per order | Razorpay 2% domestic |
| Book sale — ₹999 | ₹19.98 per order | Razorpay 2% domestic |
| International order | 3% per order | Razorpay international cards |
| Email delivery | ₹0 | Within Resend free tier (≤ 100/day) |
| D1 reads / writes | ₹0 | Well within free limits |
| Worker requests | ₹0 | Well within 100K req/day free limit |

### Realistic Monthly Scenario — Small Site

Assumptions: 5 book orders/month (avg ₹499), 50 newsletter subscribers, ~200 Worker API calls/day.

| Item | Cost |
|---|---|
| All platform services | ₹0 |
| Razorpay (5 × ₹499 × 2%) | ~₹50 |
| **Total** | **~₹50/month** |

The only recurring spend is Razorpay's transaction cut on actual sales.

### When Free Tiers Will Be Exceeded

| Trigger | Upgrade Needed | Added Cost |
|---|---|---|
| Newsletter > 100 subscribers | Resend Pro | ~₹1,700/month |
| Workers > 100K req/day | Cloudflare Workers Paid | ~₹420/month |
| D1 > 5 GB storage | Bundled with Workers Paid | Included above |
| Need custom domain email | Resend Pro or AWS SES relay | ₹1,700/month or ~₹85/month |

**Projected cost at medium scale** (500 members, 50 orders/month, weekly newsletter):

| Item | Cost |
|---|---|
| Cloudflare Workers Paid | ~₹420/month |
| Resend Pro | ~₹1,700/month |
| Razorpay (50 × ₹499) | ~₹500/month |
| GitHub / Sveltia | ₹0 |
| **Total** | **~₹2,620/month** |

---

## AWS Equivalent — Architecture & Cost Comparison

### Component Mapping

| Current (Cloudflare/GitHub) | AWS Equivalent | Notes |
|---|---|---|
| GitHub Pages | S3 + CloudFront | S3 static hosting + CDN |
| GitHub Actions | Keep as-is or CodePipeline + CodeBuild | Recommend keeping GitHub Actions |
| Sveltia CMS on `/admin` | Same (static files in S3) | No change needed |
| Cloudflare Pages (Admin Portal) | S3 + CloudFront | Same static pattern |
| Cloudflare Workers (3 workers) | AWS Lambda + API Gateway | Node.js functions |
| Cloudflare D1 (SQLite) | Amazon RDS (PostgreSQL) or DynamoDB | D1 has no direct AWS equivalent |
| Resend | Amazon SES | AWS managed email |
| Razorpay | Razorpay (unchanged) | No AWS alternative needed |
| GitHub OAuth | Amazon Cognito or keep GitHub OAuth via Lambda | Cognito adds cost |

### AWS Monthly Cost Breakdown

#### Hosting — S3 + CloudFront

| Resource | Usage | Cost |
|---|---|---|
| S3 storage (~50 MB) | Negligible | ~$0 |
| S3 PUT requests (~1,000/month) | $0.005/1,000 | ~$0.01 |
| CloudFront data transfer (10 GB/month) | First 1 TB free (12 months) → $0.085/GB | **$0 → $0.85/month** |
| CloudFront requests (100K/month) | First 10M free | ~$0 |

**Subtotal: ~$0–$1/month**

#### Compute — Lambda + API Gateway

| Resource | Usage | Cost |
|---|---|---|
| Lambda invocations (~6,000/month) | First 1M/month free (always free) | $0 |
| Lambda compute (128 MB, avg 200ms) | First 400,000 GB-s/month free (always free) | $0 |
| API Gateway REST (6,000 req/month) | First 1M free (12 months) → $3.50/M | **$0 → $0.02/month** |

**Subtotal: ~$0–$0.02/month**

> Lambda's 1M invocation free tier is permanent. API Gateway's free tier expires after 12 months.

#### Database — Amazon RDS or DynamoDB

D1 (SQLite) has no directly equivalent permanent-free AWS service. Two options:

**Option A — RDS db.t4g.micro (PostgreSQL):**

| Resource | Free Tier (12 mo) | After Free Tier |
|---|---|---|
| db.t4g.micro instance | 750 hrs/month free | **~$12/month** |
| Storage (20 GB gp2) | 20 GB free | $0.115/GB/month |

**Option B — DynamoDB (serverless, permanent free tier):**

| Resource | Always Free | Paid |
|---|---|---|
| Reads | 25 read capacity units/s | $0.25/M read units |
| Writes | 25 write capacity units/s | $1.25/M write units |
| Storage | 25 GB | $0.25/GB/month |

DynamoDB's free tier is permanent and covers this project's scale indefinitely — but requires rewriting all SQL queries to DynamoDB's key-value document model, which is a significant development effort.

**Subtotal: $0 (DynamoDB free tier) or $0 → $12–15/month (RDS after 12 months)**

#### Email — Amazon SES

| Resource | Free Tier | Paid |
|---|---|---|
| Emails sent from Lambda | 62,000/month free (12 months) | $0.10/1,000 emails |
| After free tier (200 emails/month) | — | ~$0.02/month |

SES is effectively free at this project's email volume. Crucially, **there is no daily cap** — a newsletter to any number of subscribers works without truncation.

**Subtotal: ~$0/month (essentially free at this scale)**

### AWS vs Current Stack — Final Comparison

| Component | Current (Cloudflare/GitHub) | AWS (free tier, 12 mo) | AWS (after free tier) |
|---|---|---|---|
| Static hosting | ₹0 | $0 | ~$1/month |
| Admin portal hosting | ₹0 | $0 | ~$0.50/month |
| API / compute | ₹0 | $0 | ~$0.02/month |
| Database | ₹0 | $0 (DynamoDB) | $0 (DynamoDB) or **~$12–15/month (RDS)** |
| Email | ₹0 (100/day cap) | $0 (62K/month, no daily cap) | ~$0.02/month |
| CDN | ₹0 (Cloudflare) | $0 | ~$0.85/month |
| CI/CD | ₹0 (GitHub Actions) | $0 (keep GitHub Actions) | $0 |
| Payments | 2% per transaction | 2% per transaction | Same |
| **Total fixed** | **₹0/month** | **$0/month** | **~$14–17/month (~₹1,200–1,450)** |

> Currency: $1 ≈ ₹84 (April 2026)

### Key Differences

| Factor | Current Stack | AWS |
|---|---|---|
| **Base monthly cost** | ₹0 (permanent) | ₹0 (12 months) → ₹1,200+/month |
| **Email daily cap** | 100/day (Resend free) | None (SES) |
| **Database model** | SQLite — standard SQL | RDS PostgreSQL (SQL) or DynamoDB (no SQL) |
| **Cold starts** | None (Workers always warm) | Lambda cold starts (~200–500ms, occasional) |
| **Edge latency** | Global edge (Cloudflare PoPs) | Regional by default; requires CloudFront |
| **Ops complexity** | Near zero | IAM roles, VPC, security groups, RDS snapshots |
| **Dev migration effort** | — | High — Lambda rewrite, IAM setup, schema migration |
| **Worker CPU limit** | 10ms (free), 30s (paid) | Up to 15 min (Lambda) |
| **Vendor lock-in** | Cloudflare APIs | AWS SDK, IAM, proprietary services |
| **Free tier expiry** | Most limits are permanent | 12-month free tier, then billing starts |

### When AWS Makes More Sense

- You already have an AWS account and existing infrastructure (VPC, IAM, monitoring)
- You need Lambda's longer execution time (> 10ms CPU per request)
- Your newsletter list makes the Resend daily cap a real problem and you prefer not to pay Resend Pro
- You need more complex database queries or transactions that would benefit from RDS PostgreSQL

### Bottom Line

**Stay on the current stack.** It costs ₹0/month in platform fees indefinitely, and the only spend is Razorpay's 2% on actual sales. An AWS migration would cost ₹1,200–₹1,450/month after the 12-month free tier and require substantial rewrite effort with no user-visible benefit at this scale.

The one area where AWS genuinely wins is email: SES has no daily send cap at a fraction of Resend Pro's price. If the newsletter grows past 100 subscribers, the simplest path is the **Resend + SES relay** option (documented in the Resend section above) — no architecture change, SES rates, no daily cap.
