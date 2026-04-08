// Membership Worker — Cloudflare Workers + D1 + Resend
//
// Endpoints:
//   POST /subscribe       — Public: submit a membership request
//   GET  /approve?token=  — Admin link: approve a pending member
//   GET  /reject?token=   — Admin link: reject a pending member
//   POST /newsletter      — Requires X-Newsletter-Secret header: send to approved members
//   GET  /admin/members   — Admin: list all members (GitHub OAuth)
//   POST /admin/approve   — Admin: approve a member by id (GitHub OAuth)
//   POST /admin/reject    — Admin: reject a member by id (GitHub OAuth)
//
// Required environment variables (set in Cloudflare dashboard):
//   RESEND_API_KEY       (encrypted) Resend API key
//   ADMIN_EMAIL          (plain)     Where admin notifications go
//   FROM_EMAIL           (plain)     Sender address — use "onboarding@resend.dev" for sandbox
//   SITE_URL             (plain)     Your site origin for CORS, e.g. https://anand-raj.github.io
//   WORKER_URL           (plain)     This worker's URL, e.g. https://cms-membership.xxx.workers.dev
//   ADMIN_URL            (plain)     Admin portal origin for CORS, e.g. https://admin-portal.pages.dev
//   NEWSLETTER_SECRET    (encrypted) Fallback secret for automated newsletter sends (curl/CI)
//
// D1 database binding: DB

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Timing-safe string comparison via HMAC */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('cmp'),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(String(a))),
    crypto.subtle.sign('HMAC', key, enc.encode(String(b))),
  ]);
  const ua = new Uint8Array(ha);
  const ub = new Uint8Array(hb);
  if (ua.length !== ub.length) return false;
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oneYearFrom(isoDate) {
  const d = new Date(isoDate);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.SITE_URL,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonOk(data, env) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function jsonErr(message, status, env) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function htmlPage(title, body) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: #fff; border-radius: 8px; padding: 2.5rem 2rem;
            max-width: 420px; width: 90%; text-align: center;
            box-shadow: 0 2px 12px rgba(0,0,0,.1); }
    h1 { margin: 0 0 1rem; font-size: 1.4rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>`,
    { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
  );
}

async function sendEmail(env, { to, subject, html }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html }),
    });
    if (res.ok) return;
    const errText = await res.text();
    console.error(`Resend error ${res.status} (attempt ${attempt}):`, errText);
    if (attempt < 2) await new Promise(r => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSubscribe(request, env) {
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 4096) return jsonErr('Request body too large.', 413, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonErr('Invalid request body.', 400, env);
  }

  const name     = String(body.name    || '').trim().slice(0, 100);
  const email    = String(body.email   || '').trim().toLowerCase().slice(0, 254);
  const honeypot = String(body.website || '').trim();

  // Silently accept bots without saving
  if (honeypot) return jsonOk({ ok: true }, env);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !emailRegex.test(email)) {
    return jsonErr('Name and a valid email are required.', 400, env);
  }

  const token     = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO members (name, email, status, token, created_at)
       VALUES (?, ?, 'pending', ?, ?)`
    ).bind(name, email, token, createdAt).run();
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      return jsonErr('This email is already registered.', 409, env);
    }
    console.error('DB insert error:', e);
    return jsonErr('Could not save your request. Please try again.', 500, env);
  }

  const approveUrl = `${env.WORKER_URL}/approve?token=${token}`;
  const rejectUrl  = `${env.WORKER_URL}/reject?token=${token}`;

  await sendEmail(env, {
    to: env.ADMIN_EMAIL,
    subject: `New membership request from ${escapeHtml(name)}`,
    html: `
      <p><strong>${escapeHtml(name)}</strong> (<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>) has requested membership.</p>
      <p style="margin-top:1.5rem">
        <a href="${approveUrl}"
           style="background:#16a34a;color:#fff;padding:10px 22px;border-radius:5px;
                  text-decoration:none;margin-right:12px;display:inline-block;font-weight:600">
          ✓ Approve
        </a>
        <a href="${rejectUrl}"
           style="background:#dc2626;color:#fff;padding:10px 22px;border-radius:5px;
                  text-decoration:none;display:inline-block;font-weight:600">
          ✗ Reject
        </a>
      </p>
      <p style="color:#999;font-size:.8rem">Submitted: ${createdAt}</p>
    `,
  });

  return jsonOk({ ok: true }, env);
}

async function handleApprove(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!token) return htmlPage('Invalid Link', '<p>This approval link is not valid.</p>');

  const row = await env.DB.prepare(
    `SELECT id, name, email, status, created_at FROM members WHERE token = ?`
  ).bind(token).first();

  if (!row) return htmlPage('Not Found', '<p>This link has expired or is invalid.</p>');
  const tokenAgeDays = (Date.now() - new Date(row.created_at).getTime()) / 86_400_000;
  if (tokenAgeDays > 30) {
    return htmlPage('Link Expired', '<p>This approval link has expired (older than 30 days). Ask the applicant to re-submit.</p>');
  }
  if (row.status === 'approved') {
    return htmlPage('Already Approved', `<p><strong>${escapeHtml(row.name)}</strong> is already a member.</p>`);
  }

  const approvedAt = new Date().toISOString();
  const expiresAt  = oneYearFrom(approvedAt);
  await env.DB.prepare(
    `UPDATE members SET status = 'approved', approved_at = ?, expires_at = ? WHERE token = ?`
  ).bind(approvedAt, expiresAt, token).run();

  await sendEmail(env, {
    to: row.email,
    subject: 'Your membership has been approved!',
    html: `
      <p>Hi <strong>${escapeHtml(row.name)}</strong>,</p>
      <p>Your membership request has been approved. Welcome aboard!</p>
      <p>Your membership is valid until <strong>${expiresAt.slice(0, 10)}</strong>.</p>
      <p>You will now receive newsletters and updates from us.</p>
    `,
  });

  return htmlPage(
    'Approved ✓',
    `<p><strong>${escapeHtml(row.name)}</strong> has been approved and notified by email.</p>`
  );
}

async function handleReject(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!token) return htmlPage('Invalid Link', '<p>This link is not valid.</p>');

  const row = await env.DB.prepare(
    `SELECT id, name, status FROM members WHERE token = ?`
  ).bind(token).first();

  if (!row) return htmlPage('Not Found', '<p>This link has expired or is invalid.</p>');
  if (row.status === 'rejected') {
    return htmlPage('Already Rejected', `<p><strong>${escapeHtml(row.name)}</strong> has already been rejected.</p>`);
  }

  await env.DB.prepare(
    `UPDATE members SET status = 'rejected' WHERE token = ?`
  ).bind(token).run();

  return htmlPage(
    'Rejected',
    `<p>Membership request from <strong>${escapeHtml(row.name)}</strong> has been rejected.</p>`
  );
}

async function handleNewsletter(request, env) {
  // Accept either a GitHub collaborator token (browser/admin UI) or the
  // static NEWSLETTER_SECRET (for automated curl/CI sends).
  const authHeader = request.headers.get('Authorization') || '';
  const secretHeader = request.headers.get('X-Newsletter-Secret') || '';
  const isGitHub = authHeader.startsWith('token ') || authHeader.startsWith('Bearer ');
  const isSecret = !isGitHub && env.NEWSLETTER_SECRET &&
    await safeEqual(secretHeader, env.NEWSLETTER_SECRET);

  if (!isGitHub && !isSecret) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (isGitHub && !await requireAdmin(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 512 * 1024) return new Response('Request body too large.', { status: 413 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { subject, html } = body;
  if (!subject || !html) {
    return new Response(
      JSON.stringify({ error: 'subject and html are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const MAX_RECIPIENTS = parseInt(env.MAX_NEWSLETTER_RECIPIENTS || '500', 10);
  const { results } = await env.DB.prepare(
    `SELECT name, email FROM members WHERE status = 'approved' AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT ?`
  ).bind(MAX_RECIPIENTS + 1).all();

  if (!results.length) {
    return new Response(
      JSON.stringify({ sent: 0, total: 0 }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (results.length > MAX_RECIPIENTS) {
    return new Response(
      JSON.stringify({ error: `Approved member count exceeds MAX_NEWSLETTER_RECIPIENTS (${MAX_RECIPIENTS}). Set a higher limit or use a queue-based approach for large lists.` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Resend batch API — max 100 per call
  const BATCH = 100;
  let sent = 0;

  for (let i = 0; i < results.length; i += BATCH) {
    const emails = results.slice(i, i + BATCH).map(m => ({
      from: env.FROM_EMAIL,
      to: m.email,
      subject,
      html: html.replace(/\{\{name\}\}/g, m.name),
    }));

    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emails),
    });

    if (res.ok) {
      sent += emails.length;
    } else {
      console.error(`Resend batch error ${res.status}:`, await res.text());
    }
  }

  return new Response(
    JSON.stringify({ sent, total: results.length }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// ---------------------------------------------------------------------------
// Admin auth — D1 admins table
// ---------------------------------------------------------------------------

async function validateAdminToken(ghToken, env) {
  // Check cache (SHA-256 keyed, 5-min TTL)
  const enc     = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(ghToken));
  const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const cacheKey = new Request(`https://internal-admin-auth-cache/${hashHex}`);
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if (cached) {
    const text = await cached.text();
    return text === 'none' ? null : text; // returns role string or null
  }

  async function storeResult(role) {
    await cache.put(cacheKey, new Response(role ?? 'none', {
      headers: { 'Cache-Control': 'public, max-age=300' },
    }));
    return role;
  }

  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${ghToken}`,
        'User-Agent': 'cms-membership-worker',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!userRes.ok) return storeResult(null);
    const { login } = await userRes.json();
    if (!login) return storeResult(null);

    const row = await env.DB.prepare(
      `SELECT role FROM admins WHERE github_login = ?`
    ).bind(login).first();

    return storeResult(row ? row.role : null);
  } catch {
    return null; // network error — do not cache
  }
}

async function requireAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('token ') || authHeader.startsWith('Bearer ')) {
    const ghToken = authHeader.replace(/^(token|Bearer)\s+/, '');
    return validateAdminToken(ghToken, env);
  }
  return null;
}

function adminCorsHeaders(env, request) {
  const origin  = (request && request.headers.get('Origin')) || '';
  const allowed = [env.ADMIN_URL, 'http://localhost:5173'];
  const allowedOrigin = allowed.includes(origin) ? origin : env.ADMIN_URL;
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ---------------------------------------------------------------------------
// GET /admin/members
// ---------------------------------------------------------------------------

async function handleAdminMembers(request, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, name, email, status, created_at, approved_at, expires_at
     FROM members
     ORDER BY created_at DESC`
  ).all();

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

// ---------------------------------------------------------------------------
// POST /admin/approve   body: { id }
// POST /admin/reject    body: { id }
// ---------------------------------------------------------------------------

async function handleAdminApprove(request, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }
  const id = parseInt(body.id, 10);
  if (!id) {
    return new Response(JSON.stringify({ error: 'id is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const row = await env.DB.prepare(
    `SELECT id, name, email, status FROM members WHERE id = ?`
  ).bind(id).first();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Member not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  if (row.status === 'approved') {
    return new Response(JSON.stringify({ ok: true, already: true }), {
      headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const approvedAt = new Date().toISOString();
  const expiresAt  = oneYearFrom(approvedAt);
  await env.DB.prepare(
    `UPDATE members SET status = 'approved', approved_at = ?, expires_at = ? WHERE id = ?`
  ).bind(approvedAt, expiresAt, id).run();

  await sendEmail(env, {
    to: row.email,
    subject: 'Your membership has been approved!',
    html: `
      <p>Hi <strong>${escapeHtml(row.name)}</strong>,</p>
      <p>Your membership request has been approved. Welcome aboard!</p>
      <p>Your membership is valid until <strong>${expiresAt.slice(0, 10)}</strong>.</p>
      <p>You will now receive newsletters and updates from us.</p>
    `,
  });

  return new Response(JSON.stringify({ ok: true, expires_at: expiresAt }), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

async function handleAdminReject(request, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }
  const id = parseInt(body.id, 10);
  if (!id) {
    return new Response(JSON.stringify({ error: 'id is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const row = await env.DB.prepare(
    `SELECT id, name, status FROM members WHERE id = ?`
  ).bind(id).first();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Member not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  if (row.status === 'rejected') {
    return new Response(JSON.stringify({ ok: true, already: true }), {
      headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  await env.DB.prepare(
    `UPDATE members SET status = 'rejected' WHERE id = ?`
  ).bind(id).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

// ---------------------------------------------------------------------------
// POST /admin/renew   body: { id }
// ---------------------------------------------------------------------------

async function handleAdminRenew(request, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }
  const id = parseInt(body.id, 10);
  if (!id) {
    return new Response(JSON.stringify({ error: 'id is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const row = await env.DB.prepare(
    `SELECT id, name, email, status FROM members WHERE id = ?`
  ).bind(id).first();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Member not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }
  if (row.status !== 'approved') {
    return new Response(JSON.stringify({ error: 'Member is not approved' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const newExpiry = oneYearFrom(new Date().toISOString());
  await env.DB.prepare(
    `UPDATE members SET expires_at = ? WHERE id = ?`
  ).bind(newExpiry, id).run();

  return new Response(JSON.stringify({ ok: true, expires_at: newExpiry }), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

// ---------------------------------------------------------------------------
// GET    /admin/admins       — list all admins
// POST   /admin/admins       — add admin  body: { github_login, role }
// DELETE /admin/admins/:id   — remove admin
// ---------------------------------------------------------------------------

async function handleAdminListAdmins(request, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, github_login, role, added_at FROM admins ORDER BY added_at DESC`
  ).all();

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

async function handleAdminAddAdmin(request, env) {
  const role = await requireAdmin(request, env);
  if (role !== 'owner') {
    return new Response(JSON.stringify({ error: 'Only owners can add admins' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const github_login = String(body.github_login || '').trim().toLowerCase().slice(0, 100);
  const newRole = ['owner', 'moderator'].includes(body.role) ? body.role : 'moderator';
  if (!github_login) {
    return new Response(JSON.stringify({ error: 'github_login is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO admins (github_login, role, added_at) VALUES (?, ?, ?)`
    ).bind(github_login, newRole, new Date().toISOString()).run();
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      return new Response(JSON.stringify({ error: 'This admin already exists' }), {
        status: 409, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
      });
    }
    throw e;
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

async function handleAdminRemoveAdmin(request, url, env) {
  const role = await requireAdmin(request, env);
  if (role !== 'owner') {
    return new Response(JSON.stringify({ error: 'Only owners can remove admins' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const id = parseInt(url.pathname.split('/').pop(), 10);
  if (!id) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  await env.DB.prepare(`DELETE FROM admins WHERE id = ?`).bind(id).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      const isAdmin = url.pathname.startsWith('/admin/');
      return new Response(null, {
        status: 204,
        headers: isAdmin ? adminCorsHeaders(env, request) : corsHeaders(env),
      });
    }

    // Parameterised admin routes
    if (request.method === 'DELETE' && url.pathname.startsWith('/admin/admins/')) {
      return handleAdminRemoveAdmin(request, url, env);
    }

    switch (`${request.method} ${url.pathname}`) {
      case 'POST /subscribe':        return handleSubscribe(request, env);
      case 'GET /approve':           return handleApprove(url, env);
      case 'GET /reject':            return handleReject(url, env);
      case 'POST /newsletter':       return handleNewsletter(request, env);
      case 'GET /admin/members':     return handleAdminMembers(request, env);
      case 'POST /admin/approve':    return handleAdminApprove(request, env);
      case 'POST /admin/reject':     return handleAdminReject(request, env);
      case 'POST /admin/renew':      return handleAdminRenew(request, env);
      case 'GET /admin/admins':      return handleAdminListAdmins(request, env);
      case 'POST /admin/admins':     return handleAdminAddAdmin(request, env);
      default:                       return new Response('Not found', { status: 404 });
    }
  },
};
