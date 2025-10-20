// ======================= ESP Server (final) =======================
// - Webhook /webhook (Smartlead): en v2 SOLO suma si el UA es humano
// - Píxel /o.gif: registra SIEMPRE apertura humana real (UA/IP del lector)
// - Rutas lectura: /, /leads, /leads.csv, /leads/:email
// - Idempotencia con lead_events_dedup
// - Almacén de auditoría en lead_open_events_v2
// ================================================================

const express   = require('express');
const { Pool }  = require('pg');
const dotenv    = require('dotenv');
const bodyParser= require('body-parser');
const { Parser }= require('json2csv');

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
    /(iphone|ipad|android|windows nt|macintosh|linux).*?(chrome|safari|firefox|edge)/i.test(s) ||
    /(microsoft outlook|ms-office|office|msie|trident\/\d+\.\d+)/i.test(s) ||
    /(mozilla\/5\.0).*?(windows nt|macintosh).*?(outlook)/i.test(s)
  );
}
function sameDay(a, b) {
  if (!a || !b) return false;
  const A = new Date(a), B = new Date(b);
  return A.toDateString() === B.toDateString();
}

// Extracción robusta (parche A)
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
    reqHeaders['user-agent'] || // axios si viene del webhook
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

// Keep-alive
setInterval(() => console.log('🌀 Keep-alive ping cada 25 segundos'), 25 * 1000);

// -------------------------- Rutas lectura --------------------------
app.get('/', (_req, res) => res.send('✅ API funcionando correctamente'));

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

// --------------------------- Webhook v2 ----------------------------
app.post('/webhook', async (req, res) => {
  const data = req.body;

  // Normalización
  const rawType = (data.event_type || data.eventType || data.event || '').toLowerCase();
  const email   = data.email || data.to_email || data.recipient;
  const ts      = data.timestamp || data.time_sent || data.event_timestamp || data.occurred_at || new Date().toISOString();
  const eventAt = new Date(ts);

  if (!rawType || !email || !ts) {
    console.log('⚠️ Webhook ignorado por falta de datos clave:', { rawType, email, ts });
    return res.status(400).send('Faltan datos clave');
  }

  const event_type =
    /open/.test(rawType)   ? 'email_open'  :
    /click/.test(rawType)  ? 'email_click' :
    /reply|respond/.test(rawType) ? 'email_reply' :
    /sent|delivered/.test(rawType) ? 'email_sent' :
    rawType;

  const ua = extractUA(data, req.headers);
  const ip = extractIP(data, req.headers, req.ip);

  // Debug estructura (opcional)
  if (event_type === 'email_open' && process.env.DEBUG_UA === '1') {
    try {
      const sample = {
        keys: Object.keys(data || {}),
        nested: {
          client:  data?.client  ? Object.keys(data.client)  : null,
          device:  data?.device  ? Object.keys(data.device)  : null,
          open:    data?.open    ? Object.keys(data.open)    : null,
          headers: data?.headers ? Object.keys(data.headers) : null,
        }
      };
      console.log('🧪 UA debug sample:', JSON.stringify(sample).slice(0, 900));
    } catch {}
  }

  // Idempotencia
  const eventId = data.event_id || data.id || `${email}-${event_type}-${eventAt.getTime()}`;
  try {
    await pool.query(
      `INSERT INTO lead_events_dedup (event_id, email, event_type)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [eventId, email, event_type]
    );
    const { rowCount } = await pool.query('SELECT 1 FROM lead_events_dedup WHERE event_id = $1', [eventId]);
    if (rowCount === 0) return res.status(200).send('Evento duplicado ignorado');
  } catch (e) {
    console.warn('Dedup no disponible, se continúa:', e.message);
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
      console.log('🆕 Nuevo lead creado:', email);
    }
    const lead = r.rows[0];

    // Heurística
    const uaIsProxy = looksLikeProxyUA(ua);
    const ipIsProxy = looksLikeProxyIP(ip);
    const uaIsHuman = looksLikeHumanUA(ua);

    const lastSentV2 = lead.last_sent_v2 ? new Date(lead.last_sent_v2) : null;
    const lastOpenV2 = lead.last_open_v2 ? new Date(lead.last_open_v2) : null;
    const secondsSinceSend = lastSentV2 ? (eventAt - lastSentV2) / 1000 : null;
    const tooFast = secondsSinceSend !== null && secondsSinceSend < 12; // apoyo
    const sameDayDup = sameDay(lastOpenV2, eventAt);

    // v2 NO SE DUPLICA:
    // - Por webhook solo cuenta v2 si UA es humano y no-proxy
    // - Si es proxy, va a suspicious_open_count
    let updates = [];
    let values = [email];
    let i = 2;
    let newScore = lead.score_v2 || 0;
    let segment  = lead.segment_v2 || 'zombie';

    if (event_type === 'email_sent') {
      updates.push(`send_count_v2 = COALESCE(send_count_v2,0) + 1`);
      updates.push(`last_sent_v2 = $${i++}`); values.push(eventAt);
    }

    if (event_type === 'email_open') {
      updates.push(`last_open_v2 = $${i++}`); values.push(eventAt);

      if (uaIsHuman && !uaIsProxy) {
        if (!sameDayDup) {
          updates.push(`open_count_v2 = COALESCE(open_count_v2,0) + 1`);
          updates.push(`human_open_count = COALESCE(human_open_count,0) + 1`);
          newScore += 1;
        }
      } else if (uaIsProxy || ipIsProxy || (tooFast && (uaIsProxy || ipIsProxy))) {
        updates.push(`suspicious_open_count = COALESCE(suspicious_open_count,0) + 1`);
      }

      // Auditoría (no bloqueante)
      try {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious)
           VALUES ($1,$2,$3,$4,$5)`,
          [email, eventAt, ua, ip, !!(uaIsProxy || ipIsProxy)]
        );
      } catch (_) {}
    }

    if (event_type === 'email_click') {
      updates.push(`last_click_v2 = $${i++}`); values.push(eventAt);
      updates.push(`click_count_v2 = COALESCE(click_count_v2,0) + 1`);
      newScore += 5;
    }

    if (event_type === 'email_reply') {
      updates.push(`last_reply_v2 = $${i++}`); values.push(eventAt);
      updates.push(`reply_count_v2 = COALESCE(reply_count_v2,0) + 1`);
      newScore += 10;
    }

    // Segmentación v2 (VIP exige señales humanas)
    const humanSignals =
      (lead.reply_count_v2 > 0 || event_type === 'email_reply') ||
      (lead.click_count_v2 > 0 || event_type === 'email_click') ||
      (
        ((lead.human_open_count || 0) + ((event_type === 'email_open' && uaIsHuman && !uaIsProxy && !sameDayDup) ? 1 : 0)) >= 2
      );

    if (humanSignals && newScore >= 12)      segment = 'vip';
    else if (newScore >= 6)                  segment = 'activo';
    else if (newScore >= 2)                  segment = 'dormido';
    else                                     segment = 'zombie';

    updates.push(`score_v2 = $${i++}`);   values.push(newScore);
    updates.push(`segment_v2 = $${i++}`); values.push(segment);

    if (updates.length > 0) {
      const sql = `UPDATE leads SET ${updates.join(', ')} WHERE email = $1`;
      await pool.query(sql, values);
    }

    const label =
      event_type === 'email_open'
        ? ((uaIsHuman && !uaIsProxy) ? '🧑 humano' : (uaIsProxy ? '🤖 sospechoso' : 'no-proxy'))
        : event_type;

    console.log(`v2 ✅ ${email} → ${segment} (score_v2 ${newScore}) | ${event_type === 'email_open' ? `open ${label}${sameDayDup ? ' (dup día)' : ''}` : event_type}`);
    res.send('OK');
  } catch (err) {
    console.error('❌ Error al procesar webhook v2:', err.message);
    res.status(500).send('Error interno');
  }
});

// ------------------------- Píxel /o.gif ---------------------------
// /o.gif?e=<email>&m=<message_id_opcional>
app.get('/o.gif', async (req, res) => {
  try {
    const email = (req.query.e || '').toString().trim().toLowerCase();
    const mid   = (req.query.m || '').toString().trim();
    if (!email) { res.status(400).end(); return; }

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
    }
    const lead = r.rows[0];

    const now = new Date();
    const lastOpenV2 = lead.last_open_v2 ? new Date(lead.last_open_v2) : null;
    const sameDayDup = lastOpenV2 && (lastOpenV2.toDateString() === now.toDateString());

    // UA/IP reales del cliente
    const ua = req.headers['user-agent'] || '';
    const ip = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString();

    // Idempotencia por pixel
    const eventId = `pixel-${email}-${mid || now.getTime()}`;
    await pool.query(
      `INSERT INTO lead_events_dedup (event_id, email, event_type)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [eventId, email, 'email_open_pixel']
    );
    const { rowCount } = await pool.query('SELECT 1 FROM lead_events_dedup WHERE event_id = $1', [eventId]);

    if (rowCount > 0) {
      let updates = [];
      let values  = [email];
      let i = 2;
      let newScore = lead.score_v2 || 0;

      updates.push(`last_open_v2 = $${i++}`); values.push(now);
      if (!sameDayDup) {
        updates.push(`open_count_v2 = COALESCE(open_count_v2,0) + 1`);
        updates.push(`human_open_count = COALESCE(human_open_count,0) + 1`);
        newScore += 1;
      }
      updates.push(`score_v2 = $${i++}`); values.push(newScore);

      // Segmentación rápida
      let segment = lead.segment_v2 || 'zombie';
      const humanOpens = (lead.human_open_count || 0) + (sameDayDup ? 0 : 1);
      if (newScore >= 12 && humanOpens >= 2) segment = 'vip';
      else if (newScore >= 6)                segment = 'activo';
      else if (newScore >= 2)                segment = 'dormido';
      updates.push(`segment_v2 = $${i++}`);  values.push(segment);

      const sql = `UPDATE leads SET ${updates.join(', ')} WHERE email = $1`;
      await pool.query(sql, values);

      await pool.query(
        `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious)
         VALUES ($1,$2,$3,$4,$5)`,
        [email, now, ua, ip, false]
      );

      console.log(`v2 ✅ ${email} → ${segment} (score_v2 ${newScore}) | open 🧑 humano (pixel)${sameDayDup ? ' (dup día)' : ''}`);
    }

    // GIF 1×1 transparente (sin caché)
    const gif1x1 = Buffer.from('47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b','hex');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).end(gif1x1, 'binary');
  } catch (e) {
    // Nunca romper la carga de imágenes
    res.status(200).end();
  }
});

// ----------------------------- Start ------------------------------
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
