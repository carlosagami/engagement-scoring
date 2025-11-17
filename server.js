// ======================= ESP Server v3.1 (Engagement Scoring) =======================
// - Webhook /webhook (Smartlead):
//     * sent/click/reply actualizan métricas y score
//     * open registra actividad, pero la FUENTE OFICIAL de opens para score es el píxel
// - Píxel /o.gif:
//     * fuente principal y confiable de opens
//     * heurística anti-bot (UA/IP/timing) con posibilidad de:
//         - primer hit sospechoso
//         - segundo hit humano DESPUÉS (mismo mid) que SÍ suma score
//     * ON CONFLICT sobre (email, message_base) en lead_open_events_v2
//     * dedup de score por mid vía lead_events_dedup (solo para score)
// - Rutas lectura: /, /leads, /leads.csv, /leads/:email
// - Idempotencia webhook: lead_events_dedup
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

const PIXEL_MIN_SECONDS_HUMAN = 5;   // <5s desde last_sent_v2 = sospechoso
const SAME_DAY_OPEN_DEDUP     = true; // si true, no sumamos score dos veces el mismo día por píxel

// -------------------- Utilidades & Heurísticas --------------------

function looksLikeProxyUA(ua = '') {
  const s = ua.toLowerCase();
  return /(googleimageproxy|google proxy|mpp|apple|icloud|outlook-httpproxy|outlookimgcache|microsoft-httpproxy|office365-httpproxy|proofpoint|mimecast|barracuda|trendmicro|symantec|sophos)/i.test(s);
}

function looksLikeProxyIP(ip = '') {
  const s = String(ip || '').toLowerCase();
  return /(google|microsoft|outlook|office|icloud|apple|yahoo|aol|proofpoint|mimecast)/i.test(s);
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

function sameDay(a, b) {
  if (!a || !b) return false;
  const A = new Date(a), B = new Date(b);
  return A.toDateString() === B.toDateString();
}

// Extracción robusta para webhook (Smartlead / otros ESPs)
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

// Clasificación del hit del píxel permitiendo:
// - primer hit sospechoso (tooFast / gateway)
// - segundo hit humano si pasa heurística
function classifyPixelOpen({ ua, ip, secondsSinceSend }) {
  const uaLower = (ua || '').toLowerCase();
  const ipLower = (ip || '').toLowerCase();

  const isGoogleImageProxy = /googleimageproxy/.test(uaLower);
  const isAppleMPP         = /(apple|icloud).*(proxy|mail|mpp)/.test(uaLower);
  const isSecurityGateway  = /(proofpoint|mimecast|barracuda|trendmicro|symantec|sophos)/.test(uaLower);

  const looksHuman = looksLikeHumanUA(ua);

  // 1) Too fast desde el envío => inhumano sí o sí
  if (secondsSinceSend !== null && secondsSinceSend < PIXEL_MIN_SECONDS_HUMAN) {
    return {
      isHuman: false,
      isSuspicious: true,
      secondsSinceSend,
      reason: `tooFast_${secondsSinceSend.toFixed(2)}s`
    };
  }

  // 2) Gateways de seguridad conocidos (no nos interesa contarlos como humanos)
  if (isSecurityGateway) {
    return {
      isHuman: false,
      isSuspicious: true,
      secondsSinceSend,
      reason: 'security_gateway'
    };
  }

  // 3) UA claramente humano (navegador/cliente de correo)
  if (looksHuman) {
    return {
      isHuman: true,
      isSuspicious: false,
      secondsSinceSend,
      reason: 'humanUA'
    };
  }

  // 4) Proxies de imagen tipo Gmail / Apple MPP, PERO ya pasó la ventana "tooFast"
  if (isGoogleImageProxy) {
    return {
      isHuman: true,
      isSuspicious: false,
      secondsSinceSend,
      reason: 'gmail_proxy_after_delay'
    };
  }

  if (isAppleMPP) {
    return {
      isHuman: true,
      isSuspicious: false,
      secondsSinceSend,
      reason: 'apple_mpp_after_delay'
    };
  }

  // 5) Fallback: lo tratamos como sospechoso
  return {
    isHuman: false,
    isSuspicious: true,
    secondsSinceSend,
    reason: 'fallback_ua_ip'
  };
}

// Keep-alive
setInterval(() => console.log('🌀 Keep-alive ping cada 25 segundos'), 25 * 1000);

// -------------------------- Rutas lectura --------------------------

app.get('/', (_req, res) => res.send('✅ API Engagement v3.1 funcionando correctamente'));

app.get('/leads', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY email');
    res.json(rows);
  } catch (err) {
    console.error('❌ Error al obtener leads:', err.message);
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
    console.error('❌ Error al generar CSV:', err.message);
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
    console.error('❌ Error al obtener lead:', err.message);
    res.status(500).send('Error al obtener lead');
  }
});

// --------------------------- Webhook v3.1 ----------------------------
// Webhook: NO suma opens al score.
// - sent/click/reply: sí impactan score y segment
// - open: registra actividad (last_open_v2 + lead_open_events_v2)

app.post('/webhook', async (req, res) => {
  const data = req.body;

  const rawType = (data.event_type || data.eventType || data.event || '').toLowerCase();
  const email   = data.email || data.to_email || data.recipient;
  const ts      = data.timestamp || data.time_sent || data.event_timestamp || data.occurred_at || new Date().toISOString();
  const eventAt = new Date(ts);

  if (!rawType || !email || !ts) {
    console.log('⚠️ Webhook ignorado por falta de datos clave:', { rawType, email, ts });
    return res.status(400).send('Faltan datos clave');
  }

  const event_type =
    /open/.test(rawType)          ? 'email_open'  :
    /click/.test(rawType)         ? 'email_click' :
    /reply|respond/.test(rawType) ? 'email_reply' :
    /sent|delivered/.test(rawType)? 'email_sent'  :
    rawType;

  const ua = extractUA(data, req.headers);
  const ip = extractIP(data, req.headers, req.ip);

  // Idempotencia webhook
  const eventId = data.event_id || data.id || `${email}-${event_type}-${eventAt.getTime()}`;
  try {
    await pool.query(
      `INSERT INTO lead_events_dedup (event_id, email, event_type)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [eventId, email, event_type]
    );
    const { rowCount } = await pool.query('SELECT 1 FROM lead_events_dedup WHERE event_id = $1', [eventId]);
    if (rowCount === 0) {
      return res.status(200).send('Evento duplicado ignorado');
    }
  } catch (e) {
    console.warn('⚠️ Dedup webhook no disponible, continuando:', e.message);
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
      console.log('🆕 Nuevo lead creado (webhook):', email);
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

    // Open (solo registro, no score)
    if (event_type === 'email_open') {
      const isSuspicious =
        !uaIsHuman || uaIsProxy || ipIsProxy || tooFast;

      updates.push(`last_open_v2 = $${i++}`); values.push(eventAt);

      try {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING`,
          [email, eventAt, ua, ip, isSuspicious]
        );
      } catch (e) {
        console.warn('⚠️ Error guardando auditoría open (webhook):', e.message);
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

    // Segmentación basada en score + señales humanas (clicks/replies + opens humanos del píxel)
    if (event_type === 'email_click' || event_type === 'email_reply') {
      const humanOpens = lead.human_open_count || 0;
      const humanSignals =
        (lead.reply_count_v2 > 0 || event_type === 'email_reply') ||
        (lead.click_count_v2 > 0 || event_type === 'email_click') ||
        (humanOpens >= 2);

      if (humanSignals && newScore >= 12)      segment = 'vip';
      else if (newScore >= 6)                  segment = 'activo';
      else if (newScore >= 2)                  segment = 'dormido';
      else                                     segment = 'zombie';

      updates.push(`score_v2 = $${i++}`);   values.push(newScore);
      updates.push(`segment_v2 = $${i++}`); values.push(segment);
    }

    if (updates.length > 0) {
      const sql = `UPDATE leads SET ${updates.join(', ')} WHERE email = $1`;
      await pool.query(sql, values);
    }

    console.log(`webhook ✅ ${email} → ${segment} (score_v2 ${newScore}) | ${event_type}`);
    res.send('OK');
  } catch (err) {
    console.error('❌ Error al procesar webhook v3.1:', err.message);
    res.status(500).send('Error interno');
  }
});

// ------------------------- Píxel /o.gif v3.1 ---------------------------
// /o.gif?e=<email>&m=<message_base_id>
//
// - Clasifica cada hit (sospechoso / humano) usando timing + UA.
// - Inserta/actualiza lead_open_events_v2 con ON CONFLICT (email,message_base).
// - Permite primer hit sospechoso y luego uno humano que SÍ sume score.
// - Usa lead_events_dedup SOLO para dedup de score (event_id = pixel-score-...).

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
      console.log('🆕 Nuevo lead creado (pixel):', email);
    }
    const lead = r.rows[0];

    const now = new Date();

    // UA/IP reales del cliente (o del proxy/bot)
    const ua = req.headers['user-agent'] || '';
    const ip = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString();

    const lastSentV2 = lead.last_sent_v2 ? new Date(lead.last_sent_v2) : null;
    const secondsSinceSend = lastSentV2 ? (now - lastSentV2) / 1000 : null;

    const { isHuman, isSuspicious, reason } = classifyPixelOpen({
      ua,
      ip,
      secondsSinceSend
    });

    // ----------------- Registrar/actualizar evento de open -----------------
    try {
      if (mid) {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious, message_base)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (email, message_base) DO UPDATE
           SET opened_at    = EXCLUDED.opened_at,
               user_agent   = EXCLUDED.user_agent,
               ip           = EXCLUDED.ip,
               is_suspicious= EXCLUDED.is_suspicious`,
          [email, now, ua, ip, !!isSuspicious, mid]
        );
      } else {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious)
           VALUES ($1,$2,$3,$4,$5)`,
          [email, now, ua, ip, !!isSuspicious]
        );
      }
    } catch (e) {
      console.warn('⚠️ Error guardando open (pixel):', e.message);
    }

    // ----------------- Si NO es humano → solo contamos sospechoso -----------------
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
        console.warn('⚠️ Error actualizando suspicious_open_count:', e.message);
      }

      console.log(
        `pixel ⚠️ ${email} → ${lead.segment_v2} (score_v2 ${lead.score_v2}) | open 🤖 sospechoso (pixel${mid ? ' msg' : ' no-mid'}) | reason=${reason || ''}` +
        (secondsSinceSend !== null ? ` | secsSinceSend=${secondsSinceSend.toFixed(2)}` : '')
      );
      sendGif(res);
      return;
    }

    // ----------------- Es humano → vemos si ya se puntuó ese mid -----------------
    let alreadyScored = false;
    if (mid) {
      const scoreEventId = `pixel-score-${email}-${mid}`;
      try {
        await pool.query(
          `INSERT INTO lead_events_dedup (event_id, email, event_type)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [scoreEventId, email, 'email_open_pixel_score']
        );
        const { rowCount } = await pool.query('SELECT 1 FROM lead_events_dedup WHERE event_id = $1', [scoreEventId]);
        if (rowCount === 0) {
          alreadyScored = true; // ya se puntuó antes este mid
        }
      } catch (e) {
        console.warn('⚠️ Error en dedup de score (pixel):', e.message);
      }
    }

    const lastOpenV2 = lead.last_open_v2 ? new Date(lead.last_open_v2) : null;
    const isSameDay = SAME_DAY_OPEN_DEDUP && lastOpenV2 && sameDay(lastOpenV2, now);

    let updates = [];
    let values  = [email];
    let i       = 2;
    let newScore = lead.score_v2 || 0;
    let segment  = lead.segment_v2 || 'zombie';

    // Siempre actualizamos last_open_v2 con el último open humano
    updates.push(`last_open_v2 = $${i++}`); values.push(now);

    // Solo sumamos open/human/score si:
    // - no está marcado como ya puntuado para este mid
    // - y no estamos dedupeando por día (si SAME_DAY_OPEN_DEDUP = true)
    let deltaHumanOpens = 0;
    if (!alreadyScored && !isSameDay) {
      updates.push(`open_count_v2 = COALESCE(open_count_v2,0) + 1`);
      updates.push(`human_open_count = COALESCE(human_open_count,0) + 1`);
      newScore += 1;
      deltaHumanOpens = 1;
    }

    const futureHumanOpens =
      (lead.human_open_count || 0) + deltaHumanOpens;

    const humanSignals =
      (lead.reply_count_v2 > 0) ||
      (lead.click_count_v2 > 0) ||
      (futureHumanOpens >= 2);

    if (humanSignals && newScore >= 12)      segment = 'vip';
    else if (newScore >= 6)                  segment = 'activo';
    else if (newScore >= 2)                  segment = 'dormido';
    else                                     segment = 'zombie';

    updates.push(`score_v2 = $${i++}`);   values.push(newScore);
    updates.push(`segment_v2 = $${i++}`); values.push(segment);

    const sql = `UPDATE leads SET ${updates.join(', ')} WHERE email = $1`;
    await pool.query(sql, values);

    console.log(
      `pixel ✅ ${email} → ${segment} (score_v2 ${newScore}) | open 🧑 humano (pixel${mid ? ' msg' : ' no-mid'}) | reason=${reason || ''}` +
      (secondsSinceSend !== null ? ` | secsSinceSend=${secondsSinceSend.toFixed(2)}` : '')
    );

    sendGif(res);
  } catch (e) {
    console.error('❌ Error en /o.gif v3.1:', e.message);
    sendGif(res);
  }
});

// ----------------------------- Start ------------------------------

app.listen(port, async () => {
  console.log(`🚀 API Engagement v3.1 corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
