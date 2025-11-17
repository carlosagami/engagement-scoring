// ======================= ESP Server v4.0 (Engagement Scoring) =======================
// - Webhook /webhook (Smartlead):
//     * sent/click/reply actualizan métricas y score_v2
//     * open SOLO registra actividad; NO suma opens humanos ni score_v2
// - Píxel /o.gif:
//     * ÚNICA fuente que:
//         - incrementa open_count_v2
//         - incrementa human_open_count
//         - suma puntos de score_v2 por open (máx 1 vez por mid)
//     * Heurística:
//         - tooFast => BOT
//         - gateways/proxies de seguridad => BOT
//         - Gmail Image Proxy / Apple MPP con delay => HUMANO
//         - Outlook real (no proxy) con delay => HUMANO
//         - TODO lo demás => BOT
//     * lead_open_events_v2: INSERT ... ON CONFLICT (email, message_base) DO UPDATE
//     * dedup de score por mid vía lead_events_dedup usando RETURNING
// ================================================================================

const express    = require('express');
const { Pool }   = require('pg');
const dotenv     = require('dotenv');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');

dotenv.config();

const app  = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json());

const pool = new Pool({
  host:     process.env.PGHOST,
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port:     process.env.PGPORT,
  ssl:      { rejectUnauthorized: false }
});

// -------------------------- Constantes & Config --------------------------

const PIXEL_MIN_SECONDS_HUMAN   = 5;   // <5s desde last_sent_v2 = sospechoso
const OUTLOOK_MIN_SECONDS_HUMAN = 60;  // <60s desde envío → no confiamos todavía en Outlook

// -------------------- Utilidades & Heurísticas --------------------

// Detecta UAs que realmente son proxies/gateways de imagen, NO navegadores normales
function looksLikeProxyUA(ua = '') {
  const s = ua.toLowerCase();
  return /googleimageproxy|google proxy|outlook-httpproxy|outlookimgcache|microsoft-httpproxy|office365-httpproxy|proofpoint|mimecast|barracuda|trendmicro|symantec|sophos/.test(s);
}

function looksLikeProxyIP(ip = '') {
  const s = String(ip || '').toLowerCase();
  return /(google|microsoft|outlook|office|icloud|apple mail|yahoo|aol|proofpoint|mimecast)/.test(s);
}

function looksLikeHumanUA(ua = '') {
  const s = ua.toLowerCase();
  return (
    // Navegadores típicos
    /(iphone|ipad|android|windows nt|macintosh|linux).*?(chrome|safari|firefox|edge)/i.test(s) ||
    // Clientes de correo de escritorio
    /(microsoft outlook|ms-office|office|msie|trident\/\d+\.\d+)/i.test(s) ||
    // Fall-back outlook raro
    /(mozilla\/5\.0).*?(windows nt|macintosh).*?(outlook)/i.test(s)
  );
}

function extractUA(payload, reqHeaders) {
  return (
    payload?.user_agent ||
    payload?.ua ||
    payload?.client?.user_agent ||
    payload?.client?.ua ||
    payload?.device?.user_agent ||
    payload?.context?.userAgent ||
    payload?.open?.user_agent ||
    payload?.headers?.['User-Agent'] ||
    reqHeaders['x-sl-user-agent'] ||
    reqHeaders['x-user-agent'] ||
    reqHeaders['user-agent'] ||
    ''
  );
}

function extractIP(payload, reqHeaders, reqIp) {
  return (
    payload?.ip ||
    payload?.client?.ip ||
    payload?.context?.ip ||
    reqHeaders['x-real-ip'] ||
    reqHeaders['x-forwarded-for'] ||
    reqIp ||
    ''
  ).toString();
}

// GIF 1×1 transparente
const GIF_1X1 = Buffer.from(
  '47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b',
  'hex'
);

function sendGif(res) {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).end(GIF_1X1, 'binary');
}

// Clasificación del hit del píxel (con Outlook incluido)
function classifyPixelOpen({ ua, ip, secondsSinceSend }) {
  const uaLower = (ua || '').toLowerCase();

  const isGoogleImageProxy = /googleimageproxy/.test(uaLower);
  const isAppleMPP         = /(apple|icloud).*(proxy|mail|mpp)/.test(uaLower);
  const isSecurityGateway  = /(proofpoint|mimecast|barracuda|trendmicro|symantec|sophos)/.test(uaLower);
  const isProxyUA          = looksLikeProxyUA(ua);
  const isProxyIP          = looksLikeProxyIP(ip);
  const isOutlookUA        = /(microsoft outlook|ms-office|outlook)/.test(uaLower);

  // 1) Demasiado rápido desde el envío => inhumano sí o sí
  if (secondsSinceSend !== null && secondsSinceSend < PIXEL_MIN_SECONDS_HUMAN) {
    return {
      isHuman: false,
      isSuspicious: true,
      secondsSinceSend,
      reason: `tooFast_${secondsSinceSend.toFixed(2)}s`
    };
  }

  // 2) Gateways de seguridad claros
  if (isSecurityGateway) {
    return {
      isHuman: false,
      isSuspicious: true,
      secondsSinceSend,
      reason: 'security_gateway'
    };
  }

  // 3) Gmail proxy / Apple MPP → señal fuerte de lectura
  if (isGoogleImageProxy || isAppleMPP) {
    if (secondsSinceSend !== null && secondsSinceSend < (PIXEL_MIN_SECONDS_HUMAN + 2)) {
      return {
        isHuman: false,
        isSuspicious: true,
        secondsSinceSend,
        reason: 'proxy_too_soon'
      };
    }

    return {
      isHuman: true,
      isSuspicious: false,
      secondsSinceSend,
      reason: isGoogleImageProxy ? 'gmail_proxy_after_delay' : 'apple_mpp_after_delay'
    };
  }

  // 4) Outlook REAL (no proxy) con retraso razonable
  if (isOutlookUA && !isProxyUA && !isProxyIP) {
    if (secondsSinceSend !== null && secondsSinceSend < OUTLOOK_MIN_SECONDS_HUMAN) {
      return {
        isHuman: false,
        isSuspicious: true,
        secondsSinceSend,
        reason: `outlook_too_soon_${secondsSinceSend.toFixed(2)}s`
      };
    }

    return {
      isHuman: true,
      isSuspicious: false,
      secondsSinceSend,
      reason: 'outlook_after_delay'
    };
  }

  // 5) Resto → sospechoso / bot
  if (looksLikeHumanUA(ua) || isProxyUA || isProxyIP) {
    return {
      isHuman: false,
      isSuspicious: true,
      secondsSinceSend,
      reason: 'non_proxy_ua'
    };
  }

  return {
    isHuman: false,
    isSuspicious: true,
    secondsSinceSend,
    reason: 'fallback_ua_ip'
  };
}

// Keep-alive
setInterval(() => console.log('🌀 [SYS] keepalive'), 25 * 1000);

// -------------------------- Rutas lectura --------------------------

app.get('/', (_req, res) => res.send('✅ API Engagement v4.0 funcionando correctamente'));

app.get('/leads', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY email');
    res.json(rows);
  } catch (err) {
    console.error('⚠️ [LEADS][ERROR] al obtener leads:', err.message);
    res.status(500).send('Error al obtener leads');
  }
});

app.get('/leads.csv', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY email');
    const parser = new Parser();
    const csv = parser.parse(rows);
    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    res.send(csv);
  } catch (err) {
    console.error('⚠️ [LEADS][CSV][ERROR] al generar CSV:', err.message);
    res.status(500).send('Error al generar CSV');
  }
});

app.get('/leads/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(404).send('Lead no encontrado');
    res.json(rows[0]);
  } catch (err) {
    console.error('⚠️ [LEADS][DETAIL][ERROR] al obtener lead:', err.message);
    res.status(500).send('Error al obtener lead');
  }
});

// --------------------------- Webhook v4.0 ----------------------------

app.post('/webhook', async (req, res) => {
  const data = req.body;

  const rawType = (data.event_type || data.eventType || data.event || '').toLowerCase();
  const email   = data.email || data.to_email || data.recipient;
  const ts      = data.timestamp || data.time_sent || data.event_timestamp || data.occurred_at || new Date().toISOString();
  const eventAt = new Date(ts);

  console.log(`📩 [WEBHOOK][IN] type=${rawType || '-'} email=${email || '-'} ts=${ts}`);

  if (!rawType || !email || !ts) {
    console.log('⚠️ [WEBHOOK][SKIP] faltan datos clave');
    return res.status(400).send('Faltan datos clave');
  }

  const event_type =
    /open/.test(rawType)          ? 'email_open'  :
    /click/.test(rawType)         ? 'email_click' :
    /reply|respond/.test(rawType) ? 'email_reply' :
    /sent|delivered|delivery/.test(rawType)? 'email_sent'  :
    rawType;

  const ua = extractUA(data, req.headers);
  const ip = extractIP(data, req.headers, req.ip);

  // Idempotencia webhook con RETURNING
  const eventId = data.event_id || data.id || `${email}-${event_type}-${eventAt.getTime()}`;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO lead_events_dedup (event_id, email, event_type)
       VALUES ($1,$2,$3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING 1`,
      [eventId, email, event_type]
    );
    if (rowCount === 0) {
      console.log(`♻️ [WEBHOOK][DEDUP] duplicate email=${email} type=${event_type}`);
      return res.status(200).send('Evento duplicado ignorado');
    }
  } catch (e) {
    console.warn('⚠️ [WEBHOOK][DEDUP][WARN]', e.message);
  }

  try {
    // Asegurar lead
    let r = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    if (!r.rows[0]) {
      await pool.query(
        `INSERT INTO leads (email, send_count_v2, open_count_v2, human_open_count, suspicious_open_count,
                            click_count_v2, reply_count_v2, score_v2, segment_v2)
         VALUES ($1,0,0,0,0,0,0,0,'zombie')`,
        [email]
      );
      r = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
      console.log(`🆕 [WEBHOOK][NEW-LEAD] email=${email}`);
    }
    const lead = r.rows[0];

    const lastSentV2 = lead.last_sent_v2 ? new Date(lead.last_sent_v2) : null;
    const secondsSinceSend = lastSentV2 ? (eventAt - lastSentV2) / 1000 : null;
    const tooFast = secondsSinceSend !== null && secondsSinceSend < PIXEL_MIN_SECONDS_HUMAN;

    const uaIsProxy = looksLikeProxyUA(ua);
    const ipIsProxy = looksLikeProxyIP(ip);
    const uaIsHuman = looksLikeHumanUA(ua);

    let updates = [];
    let values  = [email];
    let i       = 2;
    let newScore = lead.score_v2 || 0;
    let segment  = lead.segment_v2 || 'zombie';

    // Sent
    if (event_type === 'email_sent') {
      updates.push(`send_count_v2 = COALESCE(send_count_v2,0) + 1`);
      updates.push(`last_sent_v2 = $${i++}`); values.push(eventAt);
    }

    // Open (solo registro, NO score, NO human_open_count)
    if (event_type === 'email_open') {
      const isSuspicious =
        !uaIsHuman || uaIsProxy || ipIsProxy || tooFast;

      updates.push(`last_open_v2 = $${i++}`); values.push(eventAt);

      try {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious)
           VALUES ($1,$2,$3,$4,$5)`,
          [email, eventAt, ua, ip, isSuspicious]
        );
      } catch (e) {
        console.warn('⚠️ [WEBHOOK][OPEN][WARN]', e.message);
      }
    }

    // Click
    if (event_type === 'email_click') {
      updates.push(`last_click_v2 = $${i++}`); values.push(eventAt);
      updates.push(`click_count_v2 = COALESCE(click_count_v2,0) + 1`);
      newScore += 5;
    }

    // Reply
    if (event_type === 'email_reply') {
      updates.push(`last_reply_v2 = $${i++}`); values.push(eventAt);
      updates.push(`reply_count_v2 = COALESCE(reply_count_v2,0) + 1`);
      newScore += 10;
    }

    // Segmentación (solo cuando hay click/reply)
    if (event_type === 'email_click' || event_type === 'email_reply') {
      const humanOpens = lead.human_open_count || 0;
      const humanSignals =
        (lead.reply_count_v2 > 0 || event_type === 'email_reply') ||
        (lead.click_count_v2 > 0 || event_type === 'email_click') ||
        (humanOpens >= 2);

      if (humanSignals && newScore >= 12)      segment = 'vip';
      else if (humanSignals && newScore >= 6)  segment = 'activo';
      else if (newScore >= 2)                  segment = 'dormido';
      else                                     segment = 'zombie';

      updates.push(`score_v2 = $${i++}`);   values.push(newScore);
      updates.push(`segment_v2 = $${i++}`); values.push(segment);
    }

    if (updates.length > 0) {
      const sql = `UPDATE leads SET ${updates.join(', ')} WHERE email = $1`;
      await pool.query(sql, values);
    }

    const secsStr = secondsSinceSend !== null ? ` secs=${secondsSinceSend.toFixed(2)}` : '';
    console.log(`✅ [WEBHOOK][OK] email=${email} event=${event_type} seg=${segment} score=${newScore}${secsStr}`);

    res.send('OK');
  } catch (err) {
    console.error('❌ [WEBHOOK][ERROR] procesando evento:', err.message);
    res.status(500).send('Error interno');
  }
});

// ------------------------- Píxel /o.gif v4.0 ---------------------------

app.get('/o.gif', async (req, res) => {
  try {
    const email = (req.query.e || '').toString().trim().toLowerCase();
    const mid   = (req.query.m || '').toString().trim(); // baseId que manda el relay

    if (!email) {
      res.status(400).end();
      return;
    }

    // Asegurar lead
    let r = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    if (!r.rows[0]) {
      await pool.query(
        `INSERT INTO leads (email, send_count_v2, open_count_v2, human_open_count, suspicious_open_count,
                            click_count_v2, reply_count_v2, score_v2, segment_v2)
         VALUES ($1,0,0,0,0,0,0,0,'zombie')`,
        [email]
      );
      r = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
      console.log(`🆕 [PIXEL][NEW-LEAD] email=${email}`);
    }
    const lead = r.rows[0];

    const now = new Date();

    // UA/IP reales
    const ua = req.headers['user-agent'] || '';
    const ip = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString();

    const lastSentV2 = lead.last_sent_v2 ? new Date(lead.last_sent_v2) : null;
    const secondsSinceSend = lastSentV2 ? (now - lastSentV2) / 1000 : null;

    const { isHuman, isSuspicious, reason } = classifyPixelOpen({
      ua,
      ip,
      secondsSinceSend
    });

    // Registrar/actualizar evento de open usando el UNIQUE (email, message_base)
    try {
      if (mid) {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, message_base, opened_at, user_agent, ip, is_suspicious)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (email, message_base) DO UPDATE
           SET opened_at    = EXCLUDED.opened_at,
               user_agent   = EXCLUDED.user_agent,
               ip           = EXCLUDED.ip,
               is_suspicious= EXCLUDED.is_suspicious`,
          [email, mid, now, ua, ip, !!isSuspicious]
        );
      } else {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious)
           VALUES ($1,$2,$3,$4,$5)`,
          [email, now, ua, ip, !!isSuspicious]
        );
      }
    } catch (e) {
      console.warn('⚠️ [PIXEL][OPEN][WARN] al guardar open:', e.message);
    }

    // Si NO es humano → solo contamos sospechoso
    if (!isHuman) {
      try {
        await pool.query(
          `UPDATE leads
           SET suspicious_open_count = COALESCE(suspicious_open_count,0) + 1,
               last_open_v2 = $2
           WHERE email = $1`,
          [email, now]
        );
      } catch (e) {
        console.warn('⚠️ [PIXEL][SUSP][WARN] al actualizar suspicious_open_count:', e.message);
      }

      const secsStr = secondsSinceSend !== null ? ` secs=${secondsSinceSend.toFixed(2)}` : '';
      console.log(`🤖 [PIXEL][BOT] email=${email} mid=${mid || '-'} seg=${lead.segment_v2} score=${lead.score_v2} reason=${reason || 'unknown'}${secsStr}`);

      sendGif(res);
      return;
    }

    // Es humano → dedup solo por mid (una vez por correo) usando RETURNING
    let alreadyScored = false;
    if (mid) {
      try {
        const { rowCount } = await pool.query(
          `INSERT INTO lead_events_dedup (event_id, email, event_type)
           VALUES ($1,$2,$3)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING 1`,
          [`pixel-score-${email}-${mid}`, email, 'email_open_pixel_score']
        );
        if (rowCount === 0) {
          alreadyScored = true;
        }
      } catch (e) {
        console.warn('⚠️ [PIXEL][SCORE-DEDUP][WARN]', e.message);
      }
    }

    let updates = [];
    let values  = [email];
    let i       = 2;
    let newScore = lead.score_v2 || 0;
    let segment  = lead.segment_v2 || 'zombie';

    updates.push(`last_open_v2 = $${i++}`); values.push(now);

    let deltaHumanOpens = 0;
    let scoredThisPixel = false;

    if (!alreadyScored) {
      updates.push(`open_count_v2 = COALESCE(open_count_v2,0) + 1`);
      updates.push(`human_open_count = COALESCE(human_open_count,0) + 1`);
      newScore += 1;
      deltaHumanOpens = 1;
      scoredThisPixel = true;
    }

    const futureHumanOpens =
      (lead.human_open_count || 0) + deltaHumanOpens;

    const humanSignals =
      (lead.reply_count_v2 > 0) ||
      (lead.click_count_v2 > 0) ||
      (futureHumanOpens >= 2);

    if (humanSignals && newScore >= 12)      segment = 'vip';
    else if (humanSignals && newScore >= 6)  segment = 'activo';
    else if (futureHumanOpens >= 1 && newScore >= 2)  segment = 'dormido';
    else                                     segment = 'zombie';

    updates.push(`score_v2 = $${i++}`);   values.push(newScore);
    updates.push(`segment_v2 = $${i++}`); values.push(segment);

    const sql = `UPDATE leads SET ${updates.join(', ')} WHERE email = $1`;
    await pool.query(sql, values);

    const secsStr = secondsSinceSend !== null ? ` secs=${secondsSinceSend.toFixed(2)}` : '';
    console.log(
      `👀 [PIXEL][HUMAN] email=${email} mid=${mid || '-'} reason=${reason || 'unknown'} scored=${scoredThisPixel}` +
      ` score=${lead.score_v2}->${newScore} seg=${lead.segment_v2}->${segment}` +
      ` opens=${lead.human_open_count || 0}->${(lead.human_open_count || 0) + deltaHumanOpens}${secsStr}`
    );

    sendGif(res);
  } catch (e) {
    console.error('❌ [PIXEL][ERROR] en /o.gif:', e.message);
    sendGif(res);
  }
});

// ----------------------------- Start ------------------------------

app.listen(port, async () => {
  console.log('🚀 API Engagement v4.0 corriendo en puerto ' + port);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ [DB] Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ [DB][ERROR] conectando a PostgreSQL:', err.message);
  }
});
