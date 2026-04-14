// Books Worker — Razorpay + D1 + Resend
//
// Endpoints:
//   POST /books/create-order  — Validate shipping, create Razorpay order, save pending record
//   POST /books/verify        — Verify Razorpay signature, mark paid, send emails
//
// Required environment variables (set in Cloudflare dashboard):
//   RAZORPAY_KEY_ID      (plain)     Razorpay publishable key  e.g. rzp_test_xxx
//   RAZORPAY_KEY_SECRET  (encrypted) Razorpay secret key
//   RESEND_API_KEY       (encrypted) Resend API key
//   ADMIN_EMAIL          (plain)     Order notification recipient
//   FROM_EMAIL           (plain)     Sender address (use onboarding@resend.dev for sandbox)
//   SITE_URL             (plain)     Your site origin e.g. https://anand-raj.github.io
//
// D1 database binding: DB (same database as membership worker)
//
// Books must be registered in D1 before they can be purchased:
//   npx wrangler d1 execute cms-membership \
//     --remote --command \
//     "INSERT INTO books (slug, title, price_paise, in_stock) VALUES ('my-book', 'My Book', 49900, 1);"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.SITE_URL,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Verify Razorpay payment signature using HMAC-SHA256 */
async function verifyRazorpaySignature(orderId, paymentId, signature, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign(
    'HMAC', key, enc.encode(`${orderId}|${paymentId}`)
  );
  const sigHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return sigHex === signature;
}

function validateShipping(s) {
  const errors = [];
  if (!s.name  || s.name.trim().length < 2)           errors.push('Full name is required.');
  if (!s.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) errors.push('Valid email is required.');
  if (!s.phone || !/^\+?[0-9]{10,13}$/.test(s.phone.replace(/\s/g, ''))) errors.push('Valid phone number is required.');
  if (!s.address || s.address.trim().length < 5)      errors.push('Shipping address is required.');
  if (!s.city  || s.city.trim().length < 2)           errors.push('City is required.');
  if (!s.state || s.state.trim().length < 2)          errors.push('State is required.');
  if (!s.pincode || !/^[1-9][0-9]{5}$/.test(s.pincode.trim())) errors.push('Valid 6-digit pincode is required.');
  return errors;
}

// ---------------------------------------------------------------------------
// Admin auth — D1 admins table (shared with membership worker)
// ---------------------------------------------------------------------------

async function validateAdminToken(ghToken, env) {
  const enc     = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(ghToken));
  const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const cacheKey = new Request(`https://internal-admin-auth-cache/${hashHex}`);
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if (cached) {
    const text = await cached.text();
    return text === 'none' ? null : text;
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
        'User-Agent': 'cms-books-worker',
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
    return null;
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

// ---------------------------------------------------------------------------
// GET /books
// ---------------------------------------------------------------------------

async function handleListBooks(request, env) {
  const origin = new URL(request.url).origin;
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, author, description, price_paise, in_stock,
            (image_data IS NOT NULL) AS has_image FROM books ORDER BY id DESC`
  ).all();
  const books = results.map(({ has_image, ...b }) => ({
    ...b,
    image_url: has_image ? `${origin}/books/images/${b.id}` : null,
  }));
  return new Response(JSON.stringify(books), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',   // public catalog — no secret data
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
    },
  });
}

// ---------------------------------------------------------------------------
// POST /books/create-order
// ---------------------------------------------------------------------------

async function handleCreateOrder(request, env) {
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 8192) return jsonErr('Request body too large.', 413, env);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr('Invalid request body.', 400, env); }

  const slug     = String(body.slug || '').trim().toLowerCase().slice(0, 100);
  const shipping = body.shipping || {};
  const honeypot = String(body.website || '').trim();

  if (honeypot) return jsonOk({ ok: true, fake: true }, env); // silent bot rejection

  if (!slug) return jsonErr('Book slug is required.', 400, env);

  const shippingErrors = validateShipping(shipping);
  if (shippingErrors.length) {
    return jsonErr(shippingErrors[0], 400, env);
  }

  // Look up book in D1
  const book = await env.DB.prepare(
    `SELECT id, title, price_paise, in_stock FROM books WHERE slug = ?`
  ).bind(slug).first();

  if (!book)          return jsonErr('Book not found.', 404, env);
  if (!book.in_stock) return jsonErr('This book is currently out of stock.', 409, env);

  // Mock mode — skip Razorpay, return a fake order for testing
  const isMock = String(env.MOCK_PAYMENTS || '').toLowerCase() === 'true';
  const receipt = `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  let rzpOrder;
  if (isMock) {
    rzpOrder = {
      id:       `mock_order_${Date.now()}`,
      amount:   book.price_paise,
      currency: 'INR',
    };
  } else {
    const rzpAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    try {
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${rzpAuth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount:   book.price_paise,
          currency: 'INR',
          receipt,
        }),
      });

      if (!rzpRes.ok) {
        const err = await rzpRes.text();
        console.error('Razorpay error:', err);
        return jsonErr('Payment gateway error. Please try again.', 502, env);
      }
      rzpOrder = await rzpRes.json();
    } catch (e) {
      console.error('Razorpay fetch failed:', e);
      return jsonErr('Could not reach payment gateway. Please try again.', 502, env);
    }
  }

  // Save pending order in D1
  const now = new Date().toISOString();
  const cleanShipping = {
    address: String(shipping.address).trim().slice(0, 300),
    city:    String(shipping.city).trim().slice(0, 100),
    state:   String(shipping.state).trim().slice(0, 100),
    pincode: String(shipping.pincode).trim(),
  };

  try {
    await env.DB.prepare(`
      INSERT INTO orders
        (razorpay_order_id, book_slug, book_title, buyer_name, buyer_email,
         buyer_phone, shipping_address, amount_paise, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(
      rzpOrder.id,
      slug,
      book.title,
      String(shipping.name).trim().slice(0, 100),
      String(shipping.email).trim().toLowerCase().slice(0, 254),
      String(shipping.phone).trim().slice(0, 20),
      JSON.stringify(cleanShipping),
      book.price_paise,
      now
    ).run();
  } catch (e) {
    console.error('D1 insert error:', e);
    return jsonErr('Could not save order. Please try again.', 503, env);
  }

  return jsonOk({
    order_id: rzpOrder.id,
    amount:   rzpOrder.amount,
    currency: rzpOrder.currency,
    key_id:   env.RAZORPAY_KEY_ID,
    mock:     isMock,
  }, env);
}

// ---------------------------------------------------------------------------
// POST /books/verify
// ---------------------------------------------------------------------------

async function handleVerify(request, env) {
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 4096) return jsonErr('Request body too large.', 413, env);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr('Invalid request body.', 400, env); }

  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return jsonErr('Missing payment fields.', 400, env);
  }

  const isMock = String(env.MOCK_PAYMENTS || '').toLowerCase() === 'true';

  if (!isMock) {
    const valid = await verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      env.RAZORPAY_KEY_SECRET
    );
    if (!valid) {
      return jsonErr('Payment verification failed. Please contact support.', 400, env);
    }
  }

  // Fetch order from D1
  const order = await env.DB.prepare(
    `SELECT razorpay_order_id, book_title, buyer_name, buyer_email, buyer_phone,
            shipping_address, amount_paise, status
     FROM orders WHERE razorpay_order_id = ?`
  ).bind(razorpay_order_id).first();

  if (!order) {
    return jsonErr('Order not found.', 404, env);
  }

  if (order.status === 'paid') {
    // Re-send buyer confirmation in case the first delivery failed
    const addrPaid = (() => { try { return JSON.parse(order.shipping_address); } catch { return {}; } })();
    const addrTextPaid = [addrPaid.address, addrPaid.city, addrPaid.state, addrPaid.pincode].filter(Boolean).join(', ');
    const amountPaid = (order.amount_paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
    await sendEmail(env, {
      to: order.buyer_email,
      subject: `Your order confirmation — ${escapeHtml(order.book_title)}`,
      html: `
        <p>Hi <strong>${escapeHtml(order.buyer_name)}</strong>,</p>
        <p>This is a confirmation of your order (already processed).</p>
        <table style="border-collapse:collapse;font-size:0.95rem">
          <tr><td style="padding:4px 12px 4px 0;color:#666">Book</td>
              <td><strong>${escapeHtml(order.book_title)}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td>
              <td>${amountPaid}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666">Ship to</td>
              <td>${escapeHtml(addrTextPaid)}</td></tr>
        </table>
        <p>If you have any questions, please contact us.</p>
      `,
    });
    return jsonOk({ ok: true, already_paid: true }, env);
  }

  const now = new Date().toISOString();

  // Mark as paid
  await env.DB.prepare(`
    UPDATE orders
    SET status = 'paid', razorpay_payment_id = ?, paid_at = ?
    WHERE razorpay_order_id = ?
  `).bind(razorpay_payment_id, now, razorpay_order_id).run();

  // Parse shipping
  let addr = {};
  try { addr = JSON.parse(order.shipping_address); } catch {}

  const addressText = [addr.address, addr.city, addr.state, addr.pincode]
    .filter(Boolean).join(', ');

  const amountINR = (order.amount_paise / 100).toLocaleString('en-IN', {
    style: 'currency', currency: 'INR',
  });

  // Confirmation email to buyer
  await sendEmail(env, {
    to: order.buyer_email,
    subject: `Order confirmed — ${escapeHtml(order.book_title)}`,
    html: `
      <p>Hi <strong>${escapeHtml(order.buyer_name)}</strong>,</p>
      <p>Thank you for your order! Here are your details:</p>
      <table style="border-collapse:collapse;font-size:0.95rem">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Book</td>
            <td><strong>${escapeHtml(order.book_title)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td>
            <td>${amountINR}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Ship to</td>
            <td>${escapeHtml(addressText)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Payment ID</td>
            <td style="font-family:monospace;font-size:0.85rem">${escapeHtml(razorpay_payment_id)}</td></tr>
      </table>
      <p>We will dispatch your copy and send you a tracking update shortly.</p>
    `,
  });

  // Admin notification
  await sendEmail(env, {
    to: env.ADMIN_EMAIL,
    subject: `New order: ${escapeHtml(order.book_title)} from ${escapeHtml(order.buyer_name)}`,
    html: `
      <p><strong>New paid order received.</strong></p>
      <table style="border-collapse:collapse;font-size:0.95rem">
        <tr><td style="padding:4px 16px 4px 0;color:#666">Book</td>
            <td>${escapeHtml(order.book_title)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666">Amount</td>
            <td>${amountINR}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666">Name</td>
            <td>${escapeHtml(order.buyer_name)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666">Email</td>
            <td><a href="mailto:${escapeHtml(order.buyer_email)}">${escapeHtml(order.buyer_email)}</a></td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666">Phone</td>
            <td>${escapeHtml(order.buyer_phone || '—')}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666">Ship to</td>
            <td>${escapeHtml(addressText)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666">Payment ID</td>
            <td style="font-family:monospace;font-size:0.85rem">${escapeHtml(razorpay_payment_id)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666">Order ID</td>
            <td style="font-family:monospace;font-size:0.85rem">${escapeHtml(razorpay_order_id)}</td></tr>
      </table>
    `,
  });

  return jsonOk({ ok: true }, env);
}

// ---------------------------------------------------------------------------
// GET  /admin/books        — list all books (inc. unlisted)
// POST /admin/books        — add a book
// PUT  /admin/books/:id    — update a book
// GET  /admin/orders       — list all orders
// ---------------------------------------------------------------------------

async function handleAdminListBooks(request, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const origin = new URL(request.url).origin;
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, author, description, price_paise, in_stock,
            (image_data IS NOT NULL) AS has_image FROM books ORDER BY id DESC`
  ).all();
  const books = results.map(({ has_image, ...b }) => ({
    ...b,
    image_url: has_image ? `${origin}/books/images/${b.id}` : null,
  }));

  return new Response(JSON.stringify(books), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

async function handleAdminCreateBook(request, env) {
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

  const title = String(body.title || '').trim().slice(0, 200);
  const slug  = String(body.slug  || title.toLowerCase().replace(/[^a-z0-9]+/g, '-')).trim().slice(0, 100);
  const price = parseInt(body.price, 10);

  if (!title || !slug || isNaN(price) || price <= 0) {
    return new Response(JSON.stringify({ error: 'title, slug, and a positive price (₹) are required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const author      = String(body.author      || '').trim().slice(0, 200);
  const description = String(body.description || '').trim().slice(0, 2000);
  const in_stock    = body.stock !== undefined ? (parseInt(body.stock, 10) > 0 ? 1 : 0) : 1;
  const price_paise = price * 100;

  try {
    const result = await env.DB.prepare(
      `INSERT INTO books (slug, title, author, description, price_paise, in_stock) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(slug, title, author, description, price_paise, in_stock).run();

    return new Response(JSON.stringify({ ok: true, id: result.meta.last_row_id }), {
      headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      return new Response(JSON.stringify({ error: 'A book with this slug already exists' }), {
        status: 409, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
      });
    }
    throw e;
  }
}

async function handleAdminUpdateBook(request, url, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const id = parseInt(url.pathname.split('/').pop(), 10);
  if (!id) {
    return new Response(JSON.stringify({ error: 'Invalid book id' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const title       = String(body.title       || '').trim().slice(0, 200);
  const author      = String(body.author      || '').trim().slice(0, 200);
  const description = String(body.description || '').trim().slice(0, 2000);

  if (!title) {
    return new Response(JSON.stringify({ error: 'title is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const updates = ['title = ?', 'author = ?', 'description = ?'];
  const binds   = [title, author, description];
  if (body.price !== undefined) { updates.push('price_paise = ?'); binds.push(parseInt(body.price, 10) * 100); }
  if (body.stock !== undefined) { updates.push('in_stock = ?');    binds.push(parseInt(body.stock, 10) > 0 ? 1 : 0); }
  binds.push(id);

  await env.DB.prepare(
    `UPDATE books SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

// ---------------------------------------------------------------------------
// POST /admin/books/:id/image  — store cover image in D1 (base64, ≤ 500 KB)
// GET  /books/images/:id       — serve cover image from D1
// ---------------------------------------------------------------------------

async function handleAdminUploadBookImage(request, url, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const id = parseInt(url.pathname.split('/')[3], 10); // /admin/books/:id/image
  if (!id) {
    return new Response(JSON.stringify({ error: 'Invalid book id' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  let formData;
  try { formData = await request.formData(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid form data' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const file = formData.get('image');
  if (!file || typeof file === 'string') {
    return new Response(JSON.stringify({ error: 'No image file provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(file.type)) {
    return new Response(JSON.stringify({ error: 'Only JPEG, PNG, WebP, or GIF images are allowed' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  if (file.size > 500 * 1024) {
    return new Response(JSON.stringify({ error: 'Image must be under 500 KB' }), {
      status: 413, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  // Convert to base64 without spread (safe for up to 500 KB)
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);

  await env.DB.prepare(
    `UPDATE books SET image_data = ?, image_content_type = ? WHERE id = ?`
  ).bind(base64, file.type, id).run();

  const origin = new URL(request.url).origin;
  return new Response(JSON.stringify({ ok: true, url: `${origin}/books/images/${id}` }), {
    headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
  });
}

async function handleGetBookImage(url, env) {
  const id = parseInt(url.pathname.split('/').pop(), 10);
  if (!id) return new Response('Not found', { status: 404 });

  const book = await env.DB.prepare(
    `SELECT image_data, image_content_type FROM books WHERE id = ?`
  ).bind(id).first();

  if (!book || !book.image_data) return new Response('Not found', { status: 404 });

  const binaryStr = atob(book.image_data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  return new Response(bytes.buffer, {
    headers: {
      'Content-Type': book.image_content_type || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ---------------------------------------------------------------------------
// GET  /admin/orders       — list all orders
// ---------------------------------------------------------------------------

async function handleAdminListOrders(request, env) {
  if (!await requireAdmin(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...adminCorsHeaders(env, request) },
    });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, razorpay_order_id, book_slug, book_title,
            buyer_name AS name, buyer_email AS email, buyer_phone,
            shipping_address, amount_paise AS amount, status, created_at, paid_at
     FROM orders ORDER BY created_at DESC`
  ).all();

  return new Response(JSON.stringify(results), {
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

    // Parameterised routes
    if (request.method === 'PUT' && /^\/admin\/books\/\d+$/.test(url.pathname)) {
      return handleAdminUpdateBook(request, url, env);
    }
    if (request.method === 'POST' && /^\/admin\/books\/\d+\/image$/.test(url.pathname)) {
      return handleAdminUploadBookImage(request, url, env);
    }
    if (request.method === 'GET' && /^\/books\/images\/\d+$/.test(url.pathname)) {
      return handleGetBookImage(url, env);
    }

    switch (`${request.method} ${url.pathname}`) {
      case 'GET /books':               return handleListBooks(request, env);
      case 'POST /books/create-order': return handleCreateOrder(request, env);
      case 'POST /books/verify':       return handleVerify(request, env);
      case 'GET /admin/books':         return handleAdminListBooks(request, env);
      case 'POST /admin/books':        return handleAdminCreateBook(request, env);
      case 'GET /admin/orders':        return handleAdminListOrders(request, env);
      default: return new Response('Not found', { status: 404 });
    }
  },
};
