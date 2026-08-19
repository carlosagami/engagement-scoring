const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { filterCommercialCampaignRows } = require('./reporting-commercial-filter');

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_PORT = Number(process.env.REPORTING_INTERNAL_PORT || 8099);
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;

const TENANT_ID = String(process.env.M365_AUTH_TENANT_ID || '').trim();
const CLIENT_ID = String(process.env.M365_AUTH_CLIENT_ID || '').trim();
const CLIENT_SECRET = String(process.env.M365_AUTH_CLIENT_SECRET || '').trim();
const REDIRECT_URI = String(process.env.M365_AUTH_REDIRECT_URI || 'https://poweremail.shopology.com.mx/auth/redirect').trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const REPORTING_READ_TOKEN = String(process.env.REPORTING_READ_TOKEN || '').trim();
const DASHBOARD_TEMPLATE = fs.readFileSync(path.join(__dirname, 'reporting-dashboard.html'), 'utf8');
const ALLOWED_USERS = new Set(
  String(process.env.REPORTING_ALLOWED_USERS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

for (const [name, value] of Object.entries({
  M365_AUTH_TENANT_ID: TENANT_ID,
  M365_AUTH_CLIENT_ID: CLIENT_ID,
  M365_AUTH_CLIENT_SECRET: CLIENT_SECRET,
  SESSION_SECRET,
  DATABASE_URL,
  REPORTING_READ_TOKEN,
})) {
  if (!value) throw new Error(`Missing required environment variable ${name}`);
}

const sessionPool = new Pool({ connectionString: DATABASE_URL });

sessionPool.on('error', (error) => {
  console.error('[AUTH][SESSION_DB][ERROR]', error.message);
});

const sessionStore = new PgSession({
  pool: sessionPool,
  tableName: 'poweremail_reporting_sessions',
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60,
});

const msal = new ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientSecret: CLIENT_SECRET,
  },
});

app.use(
  session({
    name: 'poweremail.sid',
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

function normalizedUser(account, claims) {
  const candidates = [
    account && account.username,
    claims && claims.preferred_username,
    claims && claims.email,
    claims && claims.upn,
  ];
  return String(candidates.find(Boolean) || '').trim().toLowerCase();
}

function isAllowedUser(email) {
  if (!email) return false;
  if (ALLOWED_USERS.size === 0) return true;
  return ALLOWED_USERS.has(email.toLowerCase());
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function loginPage(message = '') {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PowerEmail Reporting</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f5f5; color:#111; }
    .box { width:min(440px, calc(100% - 40px)); background:#fff; border:1px solid #e5e5e5; border-radius:16px; padding:32px; box-shadow:0 12px 40px rgba(0,0,0,.06); }
    h1 { margin:0 0 10px; font-size:28px; }
    p { color:#555; line-height:1.5; margin:0 0 24px; }
    a.button { display:block; text-align:center; text-decoration:none; padding:12px 16px; border-radius:9px; background:#111; color:#fff; font-weight:700; }
    .notice { margin:0 0 18px; padding:12px; border-radius:8px; background:#fff4e5; color:#7a4800; font-size:14px; }
    .foot { margin-top:18px; font-size:12px; color:#777; text-align:center; }
  </style>
</head>
<body>
  <main class="box">
    <h1>PowerEmail Reporting</h1>
    <p>Consulta el desempeño de las campañas de PowerEmail con tu cuenta corporativa de Microsoft 365.</p>
    ${notice}
    <a class="button" href="/auth/signin">Iniciar sesión con Microsoft</a>
    <div class="foot">Acceso exclusivo para usuarios autorizados.</div>
  </main>
</body>
</html>`;
}

function dashboardPage(user) {
  return DASHBOARD_TEMPLATE
    .replaceAll('{{USER_NAME}}', escapeHtml(user.name || user.email))
    .replaceAll('{{USER_EMAIL}}', escapeHtml(user.email || ''));
}

app.get('/auth/signin', async (_req, res) => {
  try {
    const authUrl = await msal.getAuthCodeUrl({
      scopes: ['openid', 'profile', 'email'],
      redirectUri: REDIRECT_URI,
      prompt: 'select_account',
    });
    return res.redirect(authUrl);
  } catch (error) {
    console.error('[AUTH][SIGNIN][ERROR]', error.message);
    return res.status(500).type('html').send(loginPage('No fue posible iniciar el acceso con Microsoft.'));
  }
});

app.get('/auth/redirect', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) {
    const detail = String(req.query.error_description || req.query.error || '').trim();
    return res.status(401).type('html').send(loginPage(detail || 'Microsoft no devolvió un código de acceso válido.'));
  }

  try {
    const result = await msal.acquireTokenByCode({
      code,
      scopes: ['openid', 'profile', 'email'],
      redirectUri: REDIRECT_URI,
    });
    const email = normalizedUser(result.account, result.idTokenClaims);
    if (!isAllowedUser(email)) {
      console.warn('[AUTH][DENIED]', email || 'unknown');
      return res.status(403).type('html').send(loginPage('Tu cuenta de Microsoft 365 es válida, pero no tiene acceso a PowerEmail Reporting.'));
    }

    req.session.user = {
      email,
      name: String((result.idTokenClaims && result.idTokenClaims.name) || (result.account && result.account.name) || email),
    };
    console.log('[AUTH][LOGIN]', email);
    return req.session.save(() => res.redirect('/'));
  } catch (error) {
    console.error('[AUTH][REDIRECT][ERROR]', error.message);
    return res.status(401).type('html').send(loginPage('No fue posible validar tu sesión de Microsoft 365.'));
  }
});

app.get('/auth/signout', (req, res) => {
  const email = req.session && req.session.user && req.session.user.email;
  req.session.destroy(() => {
    if (email) console.log('[AUTH][LOGOUT]', email);
    res.clearCookie('poweremail.sid');
    res.redirect('/');
  });
});

app.get('/auth/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, authenticated: false });
  }
  return res.json({ ok: true, authenticated: true, user: req.session.user });
});

async function proxy(req, res) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'authorization', 'x-reporting-token'].includes(key.toLowerCase())) continue;
    if (value !== undefined) headers[key] = value;
  }

  headers['x-reporting-token'] = REPORTING_READ_TOKEN;

  try {
    const upstream = await fetch(UPSTREAM + req.originalUrl, {
      method: req.method,
      headers,
      redirect: 'manual',
    });
    let body = Buffer.from(await upstream.arrayBuffer());

    if (upstream.ok && req.path === '/api/campaigns') {
      try {
        const payload = JSON.parse(body.toString('utf8'));
        const filtered = await filterCommercialCampaignRows(sessionPool, payload.rows || []);
        payload.rows = filtered.rows;
        body = Buffer.from(JSON.stringify(payload), 'utf8');

        if (filtered.excluded > 0) {
          console.log('[REPORTING][CONTROL_SENDS_EXCLUDED]', {
            excludedCampaigns: filtered.excluded,
          });
        }
      } catch (error) {
        console.error('[REPORTING][FILTER][ERROR]', error.message);
        return res.status(500).json({ ok: false, error: 'campaign_filter_failed' });
      }
    }

    for (const [key, value] of upstream.headers.entries()) {
      if (['content-length', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) continue;
      res.setHeader(key, value);
    }
    return res.status(upstream.status).send(body);
  } catch (error) {
    console.error('[PROXY][ERROR]', error.message);
    return res.status(502).json({ ok: false, error: 'reporting_upstream_unavailable' });
  }
}

app.get('/health', (req, res) => proxy(req, res));

app.use('/api', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return proxy(req, res);
});

app.get('/', (req, res) => {
  if (!req.session || !req.session.user) return res.type('html').send(loginPage());
  return res.type('html').send(dashboardPage(req.session.user));
});

app.use((req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/');
  return proxy(req, res);
});

const child = spawn(process.execPath, ['reporting-server.js'], {
  env: {
    ...process.env,
    REPORTING_PORT: String(UPSTREAM_PORT),
    PORT: String(UPSTREAM_PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

child.on('exit', (code, signal) => {
  console.error('[UPSTREAM][EXIT]', { code, signal });
  process.exit(code || 1);
});

const server = app.listen(PORT, async () => {
  console.log('[AUTH][BOOT] PowerEmail M365 gateway listening on ' + PORT);
  console.log('[AUTH][UPSTREAM] reporting-server on ' + UPSTREAM_PORT);

  try {
    await sessionPool.query('SELECT 1');
    console.log('[AUTH][SESSION_DB] connected');
  } catch (error) {
    console.error('[AUTH][SESSION_DB][ERROR]', error.message);
  }
});

async function shutdown(signal) {
  console.log('[AUTH][SYS] ' + signal + ' received');
  child.kill('SIGTERM');
  server.close(async () => {
    try {
      await sessionPool.end();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
