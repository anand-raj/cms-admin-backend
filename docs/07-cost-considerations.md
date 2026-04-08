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
