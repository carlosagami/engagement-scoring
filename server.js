const crypto = require('crypto');
const net = require('net');
const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const PORT = Number(process.env.PORT || process.env.HTTP_PORT || 8080);
const CLASSIFIER_VERSION = process.env.CLASSIFIER_VERSION || 'oi-v1.2-observe';
const IP_HASH_SALT = process.env.IP_HASH_SALT || '';

function buildPool() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (connectionString) {
    const internal = connectionString.includes('railway.internal');
    return new Pool({
      connectionString,
      ssl: internal ? false : { rejectUnauthorized: false },
      max: Number(process.env.PGPOOL_MAX || 10),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }

  return new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: Number(process.env.PGPORT || 5432),
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
}

const pool = buildPool();

const GIF_1X1 = Buffer.from(
  '47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b',
  'hex'
);

function sendGif(res) {
  res.status(200);
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', String(GIF_1X1.length));
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(GIF_1X1);
}

function normalizeIp(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (value.includes(',')) value = value.split(',')[0].trim();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end > 0) value = value.slice(1, end);
  } else if (value.includes('.') && value.includes(':')) {
    value = value.split(':')[0];
  }
  return net.isIP(value) ? value : null;
}

function getClientIp(req) {
  return (
    normalizeIp(req.headers['cf-connecting-ip']) ||
    normalizeIp(req.headers['x-forwarded-for']) ||
    normalizeIp(req.headers['x-real-ip']) ||
    normalizeIp(req.ip) ||
    normalizeIp(req.socket?.remoteAddress) ||
    null
  );
}

function hashValue(value, salt = '') {
  if (!value) return null;
  return crypto.createHash('sha256').update(`${salt}|${value}`).digest('hex');
}

function secondsBetween(later, earlier) {
  if (!later || !earlier) return null;
  const delta = (new Date(later).getTime() - new Date(earlier).getTime()) / 1000;
  return Number.isFinite(delta) ? delta : null;
}

function looksLikeOutlookSecurityChrome109(ua) {
  return (
    ua.includes('windows nt 10.0; win64; x64') &&
    ua.includes('applewebkit/537.36') &&
    ua.includes('chrome/109.0.0.0') &&
    ua.includes('safari/537.36') &&
    !ua.includes('edg/')
  );
}

function classifyFetch({ userAgent, recipientProvider, secondsSinceSent, secondsSinceDelivery }) {
  const ua = String(userAgent || '').toLowerCase();
  const provider = String(recipientProvider || '').toLowerCase();
  const timing = secondsSinceDelivery ?? secondsSinceSent;

  const securityPatterns = [
    'proofpoint',
    'mimecast',
    'barracuda',
    'trendmicro',
    'trend micro',
    'symantec',
    'sophos',
    'forcepoint',
    'fortimail',
    'fortinet',
    'messagelabs',
    'spamtitan',
    'mailchannels',
  ];

  if (securityPatterns.some((pattern) => ua.includes(pattern))) {
    return {
      classification: 'security_fetch',
      reason: 'known_security_user_agent',
      humanConfidence: 0.02,
    };
  }

  if (provider === 'outlook' && looksLikeOutlookSecurityChrome109(ua)) {
    return {
      classification: 'security_fetch',
      reason: 'outlook_security_chrome109_signature',
      humanConfidence: 0.01,
    };
  }

  if (ua.includes('googleimageproxy') || ua.includes('ggpht.com')) {
    return {
      classification: 'proxy_fetch',
      reason: 'google_image_proxy',
      humanConfidence: null,
    };
  }

  if (
    (ua.includes('apple') || ua.includes('icloud')) &&
    (ua.includes('proxy') || ua.includes('mpp') || ua.includes('mail'))
  ) {
    return {
      classification: 'proxy_fetch',
      reason: 'apple_privacy_proxy',
      humanConfidence: null,
    };
  }

  if (ua.includes('microsoft image proxy') || ua.includes('outlook image proxy')) {
    return {
      classification: 'proxy_fetch',
      reason: 'microsoft_image_proxy',
      humanConfidence: null,
    };
  }

const oneOutlookClient =
  provider === 'outlook' &&
  ua.includes('oneoutlook/') &&
  ua.includes('edg/');

if (oneOutlookClient) {
  return {
    classification: 'probable_human_open',
    reason: 'oneoutlook_client_render',
    humanConfidence: 0.85,
  };
}

  const directOutlookClient =
    ua.includes('microsoft outlook') ||
    ua.includes('outlook-android') ||
    ua.includes('outlook-ios');

  if (directOutlookClient && timing !== null && timing >= 30) {
    return {
      classification: 'probable_human_open',
      reason: 'direct_outlook_client_plausible_timing',
      humanConfidence: 0.75,
    };
  }

  if (timing !== null && timing >= 0 && timing < 5) {
    return {
      classification: 'unknown_fetch',
      reason: 'very_early_fetch',
      humanConfidence: 0.1,
    };
  }

  return {
    classification: 'unknown_fetch',
    reason: ua ? 'unclassified_user_agent' : 'missing_user_agent',
    humanConfidence: null,
  };
}

const AGGREGATE_COLUMN_BY_CLASSIFICATION = Object.freeze({
  security_fetch: 'security_fetch_count',
  proxy_fetch: 'proxy_fetch_count',
  probable_human_open: 'probable_human_fetch_count',
  unknown_fetch: 'unknown_fetch_count',
});

async function recordFetch(req, token) {
  const lookup = await pool.query(
    `SELECT tracking_message_id, sent_at, delivered_at, recipient_provider
     FROM engagement.tracking_messages
     WHERE tracking_token = $1
       AND tracking_enabled = TRUE
     LIMIT 1`,
    [token]
  );

  if (lookup.rowCount === 0) {
    console.log('[OPEN][UNKNOWN_TOKEN]', { tokenHash: hashValue(token) });
    return;
  }

  const message = lookup.rows[0];
  const now = new Date();
  const userAgent = String(req.get('user-agent') || '').slice(0, 4000);
  const referer = String(req.get('referer') || '').slice(0, 4000);
  const ip = getClientIp(req);
  const cfRay = String(req.get('cf-ray') || '').slice(0, 255) || null;
  const secondsSinceSent = secondsBetween(now, message.sent_at);
  const secondsSinceDelivery = secondsBetween(now, message.delivered_at);

  const decision = classifyFetch({
    userAgent,
    recipientProvider: message.recipient_provider,
    secondsSinceSent,
    secondsSinceDelivery,
  });
  const ipHash = ip ? hashValue(ip, IP_HASH_SALT) : null;
  const requestFingerprint = hashValue(
    [userAgent, ipHash || '', referer, cfRay || ''].join('|'),
    IP_HASH_SALT
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO engagement.open_events (
         tracking_message_id, occurred_at, classification, classification_reason,
         human_confidence, user_agent, referer, ip_address, ip_hash,
         seconds_since_sent, seconds_since_delivery, request_fingerprint, cf_ray
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING open_event_id`,
      [
        message.tracking_message_id,
        now,
        decision.classification,
        decision.reason,
        decision.humanConfidence,
        userAgent || null,
        referer || null,
        ip,
        ipHash,
        secondsSinceSent,
        secondsSinceDelivery,
        requestFingerprint,
        cfRay,
      ]
    );

    await client.query(
      `INSERT INTO engagement.open_event_classifications (
         open_event_id, classifier_version, classification, reason, human_confidence
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        inserted.rows[0].open_event_id,
        CLASSIFIER_VERSION,
        decision.classification,
        decision.reason,
        decision.humanConfidence,
      ]
    );

    const aggregateColumn = AGGREGATE_COLUMN_BY_CLASSIFICATION[decision.classification];
    if (!aggregateColumn) throw new Error(`Unsupported classification: ${decision.classification}`);

    await client.query(
      `UPDATE engagement.tracking_messages
       SET first_fetch_at = COALESCE(first_fetch_at, $2),
           last_fetch_at = $2,
           raw_fetch_count = raw_fetch_count + 1,
           ${aggregateColumn} = ${aggregateColumn} + 1,
           updated_at = NOW()
       WHERE tracking_message_id = $1`,
      [message.tracking_message_id, now]
    );

    await client.query('COMMIT');

    console.log('[OPEN][RECORDED]', {
      trackingMessageId: message.tracking_message_id,
      classification: decision.classification,
      reason: decision.reason,
      secondsSinceSent,
      secondsSinceDelivery,
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

app.get('/health', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         current_database() AS database,
         to_regclass('engagement.tracking_messages') IS NOT NULL AS tracking_messages_ready,
         to_regclass('engagement.open_events') IS NOT NULL AS open_events_ready`
    );

    const row = result.rows[0];
    const ready = row.tracking_messages_ready && row.open_events_ready;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      service: 'poweremail-open-intelligence',
      classifierVersion: CLASSIFIER_VERSION,
      database: row.database,
    });
  } catch (error) {
    console.error('[HEALTH][ERROR]', error.message);
    res.status(503).json({ ok: false, service: 'poweremail-open-intelligence' });
  }
});

app.get('/o/:token.gif', (req, res) => {
  const token = String(req.params.token || '').trim();
  const validToken = /^[A-Za-z0-9_-]{16,128}$/.test(token);

  sendGif(res);

  if (!validToken) {
    console.log('[OPEN][INVALID_TOKEN_FORMAT]');
    return;
  }

  recordFetch(req, token).catch((error) => {
    console.error('[OPEN][RECORD_ERROR]', error.message);
  });
});

app.use((_req, res) => {
  res.status(404).type('text/plain').send('not found');
});

const server = app.listen(PORT, async () => {
  console.log(`[BOOT] poweremail-open-intelligence listening on ${PORT}`);
  console.log(`[BOOT] classifier=${CLASSIFIER_VERSION}`);
  try {
    await pool.query('SELECT 1');
    console.log('[DB] connected');
  } catch (error) {
    console.error('[DB][ERROR]', error.message);
  }
});

async function shutdown(signal) {
  console.log(`[SYS] ${signal} received`);
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
