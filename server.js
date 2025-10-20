const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json());

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

/* ================= Heurísticas & utilidades ================= */

// Proxies / escáneres conocidos
function looksLikeProxyUA(ua = '') {
  const s = ua.toLowerCase();
  return /(googleimageproxy|google proxy|mpp|apple|icloud|outlook-httpproxy|outlookimgcache|microsoft-httpproxy|office365-httpproxy|proofpoint|mimecast|barracuda|trendmicro|symantec|sophos)/i.test(s);
}
function looksLikeProxyIP(ip = '') {
  const s = String(ip).toLowerCase();
  return /(google|microsoft|outlook|office|icloud|apple|yahoo|aol|proofpoint|mimecast)/i.test(s);
}

// Human UA (navegadores y Outlook reales)
function looksLikeHumanUA(ua = '') {
  const s = ua.toLowerCase();
  return (
    /(iphone|ipad|android|windows nt|macintosh|linux).*?(chrome|safari|firefox|edge)/i.test(s) ||   // navegadores reales
    /(microsoft outlook|ms-office|office|msie|trident\/\d+\.\d+)/i.test(s) ||                      // Outlook desktop/MSHTML
    /(mozilla\/5\.0).*?(windows nt|macintosh).*?(outlook)/i.test(s)                                // Outlook web en navegador
  );
}

function sameDay(a, b) {
  if (!a || !b) return false;
  const A = new Date(a), B = new Date(b);
  return A.toDateString() === B.toDateString();
}

// --- Parche A: extracción robusta de UA/IP desde el payload ---
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
    reqHeaders['x-sl-user-agent'] ||   // posible header propio
    reqHeaders['x-user-agent'] ||
    reqHeaders['user-agent'] ||        // fallback (axios/...)
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

/* ================= Keep-alive ================= */
setInterval(() => console.log('🌀 Keep-alive ping cada 25 segundos'), 25 * 1000);

/* ================= Rutas de lectura (sin cambios) ================= */

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

/* ================= Webhook (MISMA ruta /webhook) ================= */

app.post('/webhook', async (req, res) => {
  const data = req.body;

  // Normalización de campos del evento
  const rawType = (data.event_type || data.eventType || data.event || '').toLowerCase();
  const email = data.email || data.to_email || data.recipient;
  const ts = data.timestamp || data.time_sent || data.event_timestamp || data.occurred_at || new Date().toISOString();
  const eventAt = new Date(ts);

  if (!rawType || !email || !ts) {
    console.log('⚠️ Webhook ignorado por falta de datos clave:', { rawType, email, ts });
    return res.status(400).send('Faltan datos clave');
  }

  const event_type =
    /open/.test(rawType)  ? 'email_open'  :
    /click/.test(rawType) ? 'email_click' :
    /reply|respond/.test(rawType) ? 'email_reply' :
    /sent|delivered/.test(rawType) ? 'email_sent' :
    rawType;

  // Parche A: tomar UA/IP del payload si existen (si no, caer a headers)
  const ua = extractUA(data, req.headers);
  const ip = extractIP(data, req.headers, req.ip);

  // Debug opcional para mapear campos del payload (activar con DEBUG_UA=1)
  if (event_type === 'email_open' && process.env.DEBUG_UA === '1') {
    try {
      const sample = {
        keys: Object.keys(data || {}),
        nested: {
          client: data?.client ? Object.keys(data.client) : null,
          device: data?.device ? Object.keys(data.device) : null,
          open:   data?.open   ? Object.keys(data.open)   : null,
          headers:data?.headers? Object.keys(data.headers): null,
        }
      };
      console.log('🧪 UA debug sample:', JSON.stringify(sample).slice(0, 900));
    } catch {}
  }

  // Idempotencia simple
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

    // Heurística prudente
    const uaIsProxy = looksLikeProxyUA(ua);
    const ipIsProxy = looksLikeProxyIP(ip);
    const uaIsHuman = looksLikeHumanUA(ua);

    const lastSentV2 = lead.last_sent_v2 ? new Date(lead.last_sent_v2) : null;
    const lastOpenV2 = lead.last_open_v2 ? new Date(lead.last_open_v2) : null;
    const secondsSinceSend = lastSentV2 ? (eventAt - lastSentV2) / 1000 : null;
    const tooFast = secondsSinceSend !== null && secondsSinceSend < 12; // apoyo; nunca criterio único
    const sameDayDup = sameDay(lastOpenV2, eventAt);

    // Solo sospechoso si huele a proxy; el tiempo solo refuerza si hay proxy.
    const suspiciousOpen =
      event_type === 'email_open' &&
      (uaIsProxy || ipIsProxy || (tooFast && (uaIsProxy || ipIsProxy)));

    // UPDATE (solo columnas v2; v1 intactas)
    let updates = [];
    let values = [email];
    let i = 2;
    let newScore = lead.score_v2 || 0;
    let segment = lead.segment_v2 || 'zombie';

    if (event_type === 'email_sent') {
      updates.push(`send_count_v2 = COALESCE(send_count_v2,0) + 1`);
      updates.push(`last_sent_v2 = $${i++}`); values.push(eventAt);
    }

    if (event_type === 'email_open') {
      updates.push(`last_open_v2 = $${i++}`); values.push(eventAt);

      if (suspiciousOpen) {
        updates.push(`suspicious_open_count = COALESCE(suspicious_open_count,0) + 1`);
      } else {
        // Apertura humana o al menos no-proxy. Evita duplicar el mismo día.
        if (!sameDayDup) {
          updates.push(`open_count_v2 = COALESCE(open_count_v2,0) + 1`);
          if (uaIsHuman && !uaIsProxy) {
            updates.push(`human_open_count = COALESCE(human_open_count,0) + 1`);
          }
          newScore += 1;
        }
      }

      // Auditoría (no bloqueante)
      try {
        await pool.query(
          `INSERT INTO lead_open_events_v2 (email, opened_at, user_agent, ip, is_suspicious)
           VALUES ($1,$2,$3,$4,$5)`,
          [email, eventAt, ua, ip, !!suspiciousOpen]
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
        ((lead.human_open_count || 0) + ((event_type === 'email_open' && !suspiciousOpen && !sameDayDup && uaIsHuman && !uaIsProxy) ? 1 : 0)) >= 2
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
        ? (suspiciousOpen ? '🤖 sospechoso' : (uaIsHuman ? '🧑 humano' : 'no-proxy'))
        : event_type;

    console.log(`v2 ✅ ${email} → ${segment} (score_v2 ${newScore}) | ${event_type === 'email_open' ? `open ${label}${sameDayDup ? ' (dup día)' : ''}` : event_type}`);
    res.send('OK');
  } catch (err) {
    console.error('❌ Error al procesar webhook v2:', err.message);
    res.status(500).send('Error interno');
  }
});

/* ================= Start ================= */

app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
