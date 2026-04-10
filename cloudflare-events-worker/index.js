// Events Registration Worker — Cloudflare Workers + D1
//
// Public endpoints (CORS: SITE_URL):
//   POST /register        — Submit a registration for an event
//
// Admin endpoints (CORS: ADMIN_URL, requires GitHub OAuth token):
//   GET  /admin/registrations              — All registrations (optionally ?event=slug)
//   GET  /admin/events                     — List distinct events that have registrations
//   POST /admin/confirm                    — Confirm a registration { id }
//   POST /admin/cancel                     — Cancel a registration  { id }
//   POST /admin/admins/add                 — Add an admin            { login, role }
//   POST /admin/admins/remove              — Remove an admin         { login }
//   GET  /admin/admins                     — List admins
//
// D1 binding: DB
// Vars: SITE_URL, ADMIN_URL

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(origin, env) {
  const allowed = [env.SITE_URL, env.ADMIN_URL, 'http://localhost:5173', 'http://localhost:4173'].filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] ?? '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonOk(data, origin, env) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

function jsonErr(msg, status, origin, env) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Validate a GitHub OAuth token and return the login, or null on failure
async function githubLogin(authHeader) {
  if (!authHeader?.startsWith('token ')) return null;
  const token = authHeader.slice(6);
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'cms-events-worker' },
    });
    if (!res.ok) return null;
    const { login } = await res.json();
    return login || null;
  } catch {
    return null;
  }
}

// Check if a GitHub login is an admin in our DB
async function isAdmin(db, login) {
  if (!login) return false;
  const row = await db.prepare('SELECT id FROM admins WHERE github_login = ?').bind(login).first();
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const url    = new URL(request.url);
    const path   = url.pathname;

    // Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    // ── Public: POST /register ──────────────────────────────────────────────
    if (path === '/register' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return jsonErr('Invalid JSON', 400, origin, env);
      }

      const { event_slug, event_title, name, email, phone, participants, notes } = body;

      if (!event_slug || !event_title || !name || !email) {
        return jsonErr('event_slug, event_title, name and email are required', 400, origin, env);
      }

      // Basic email format guard (full validation is client-side; this just blocks garbage)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonErr('Invalid email address', 400, origin, env);
      }

      const count = Math.max(1, Math.min(10, parseInt(participants) || 1));

      // Duplicate check (same email + event)
      const existing = await env.DB
        .prepare('SELECT id FROM event_registrations WHERE event_slug = ? AND email = ? AND status != "cancelled"')
        .bind(event_slug, email.toLowerCase().trim())
        .first();

      if (existing) {
        return jsonErr('You are already registered for this event.', 409, origin, env);
      }

      await env.DB.prepare(`
        INSERT INTO event_registrations
          (event_slug, event_title, name, email, phone, participants, notes, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).bind(
        escapeHtml(event_slug),
        escapeHtml(event_title),
        escapeHtml(name),
        email.toLowerCase().trim(),
        phone ? escapeHtml(phone) : null,
        count,
        notes ? escapeHtml(notes) : null,
        new Date().toISOString(),
      ).run();

      return jsonOk({ success: true, message: 'Registration received! We will confirm shortly.' }, origin, env);
    }

    // ── Admin routes — require GitHub OAuth ─────────────────────────────────
    if (path.startsWith('/admin/')) {
      const login = await githubLogin(request.headers.get('Authorization'));
      if (!login) return jsonErr('Unauthorized', 401, origin, env);

      // Auth check against shared admins table (cms-membership DB)
      const adminCount = (await env.DB.prepare('SELECT COUNT(*) as n FROM admins').first())?.n ?? 0;
      if (adminCount > 0 && !(await isAdmin(env.DB, login))) {
        return jsonErr('Forbidden', 403, origin, env);
      }

      // GET /admin/events
      if (path === '/admin/events' && request.method === 'GET') {
        const { results } = await env.DB.prepare(`
          SELECT event_slug, event_title,
                 COUNT(*) AS total,
                 SUM(participants) AS total_participants,
                 SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                 SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
                 SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
          FROM event_registrations
          GROUP BY event_slug
          ORDER BY MAX(created_at) DESC
        `).all();
        return jsonOk(results, origin, env);
      }

      // GET /admin/registrations?event=slug
      if (path === '/admin/registrations' && request.method === 'GET') {
        const eventSlug = url.searchParams.get('event');
        let stmt;
        if (eventSlug) {
          stmt = env.DB.prepare('SELECT * FROM event_registrations WHERE event_slug = ? ORDER BY created_at DESC').bind(eventSlug);
        } else {
          stmt = env.DB.prepare('SELECT * FROM event_registrations ORDER BY created_at DESC');
        }
        const { results } = await stmt.all();
        return jsonOk(results, origin, env);
      }

      // POST /admin/confirm
      if (path === '/admin/confirm' && request.method === 'POST') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return jsonErr('id required', 400, origin, env);
        await env.DB.prepare("UPDATE event_registrations SET status = 'confirmed' WHERE id = ?").bind(id).run();
        return jsonOk({ success: true }, origin, env);
      }

      // POST /admin/cancel
      if (path === '/admin/cancel' && request.method === 'POST') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return jsonErr('id required', 400, origin, env);
        await env.DB.prepare("UPDATE event_registrations SET status = 'cancelled' WHERE id = ?").bind(id).run();
        return jsonOk({ success: true }, origin, env);
      }

      // GET /admin/admins — reads from shared cms-membership DB
      if (path === '/admin/admins' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM admins ORDER BY added_at DESC').all();
        return jsonOk(results, origin, env);
      }

      // POST /admin/admins/add
      if (path === '/admin/admins/add' && request.method === 'POST') {
        const { login: newLogin, role = 'moderator' } = await request.json().catch(() => ({}));
        if (!newLogin) return jsonErr('login required', 400, origin, env);
        await env.DB.prepare('INSERT OR IGNORE INTO admins (github_login, role, added_at) VALUES (?, ?, ?)')
          .bind(newLogin, role, new Date().toISOString()).run();
        return jsonOk({ success: true }, origin, env);
      }

      // POST /admin/admins/remove
      if (path === '/admin/admins/remove' && request.method === 'POST') {
        const { login: rmLogin } = await request.json().catch(() => ({}));
        if (!rmLogin) return jsonErr('login required', 400, origin, env);
        await env.DB.prepare('DELETE FROM admins WHERE github_login = ?').bind(rmLogin).run();
        return jsonOk({ success: true }, origin, env);
      }

      return jsonErr('Not found', 404, origin, env);
    }

    return jsonErr('Not found', 404, origin, env);
  },
};
