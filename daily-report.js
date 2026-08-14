const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

dotenv.config();

const DAYS = Number.parseInt(process.env.REPORT_DAYS || '7', 10);
const TIMEZONE = String(process.env.REPORTING_TIMEZONE || 'America/Mexico_City').trim();
const REPORT_FROM = String(process.env.REPORT_FROM || 'carlos.agami@shopology.email').trim();
const REPORT_TO = String(
  process.env.REPORT_TO ||
    'carlos.agami@shopology.email,diana.tc@shopology.email,gabriel@shopology.email'
)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const REPORT_CC = String(process.env.REPORT_CC || 'jarvis@shopology.email')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

function buildPool() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();

  if (connectionString) {
    const internal = connectionString.includes('railway.internal');
    return new Pool({
      connectionString,
      ssl: internal ? false : { rejectUnauthorized: false },
      max: 4,
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
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
}

function buildTransport() {
  const host = String(process.env.REPORT_SMTP_HOST || '').trim();
  const port = Number(process.env.REPORT_SMTP_PORT || 587);
  const secure = String(process.env.REPORT_SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = String(process.env.REPORT_SMTP_USER || '').trim();
  const pass = String(process.env.REPORT_SMTP_PASS || '').trim();

  if (!host) {
    throw new Error('Missing REPORT_SMTP_HOST');
  }

  const options = {
    host,
    port,
    secure,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };

  if (user || pass) {
    options.auth = { user, pass };
  }

  return nodemailer.createTransport(options);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function secondsLabel(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds.toFixed(0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function localDateLabel() {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

async function fetchCampaignRows(pool) {
  const result = await pool.query(
    `WITH campaign_metrics AS (
       SELECT
         mos.tenant_id,
         mos.dispatch_campaign_id,
         mos.sendy_campaign_id,
         mos.sending_domain,
         MIN(mos.sent_at) AS first_sent_at,
         MAX(mos.sent_at) AS last_sent_at,
         COUNT(*) FILTER (
           WHERE mos.delivered_at IS NOT NULL
             AND mos.recipient_provider = 'outlook'
         ) AS delivered_messages,
         COUNT(*) FILTER (
           WHERE mos.delivered_at IS NOT NULL
             AND mos.recipient_provider = 'outlook'
             AND mos.unique_human_open = TRUE
         ) AS unique_human_opens,
         ROUND(
           100.0 * COUNT(*) FILTER (
             WHERE mos.delivered_at IS NOT NULL
               AND mos.recipient_provider = 'outlook'
               AND mos.unique_human_open = TRUE
           ) /
           NULLIF(
             COUNT(*) FILTER (
               WHERE mos.delivered_at IS NOT NULL
                 AND mos.recipient_provider = 'outlook'
             ),
             0
           ),
           2
         ) AS open_rate_pct,
         AVG(mos.seconds_to_first_human_open) FILTER (
           WHERE mos.delivered_at IS NOT NULL
             AND mos.recipient_provider = 'outlook'
             AND mos.unique_human_open = TRUE
         ) AS avg_seconds_to_first_open,
         PERCENTILE_CONT(0.5) WITHIN GROUP (
           ORDER BY mos.seconds_to_first_human_open
         ) FILTER (
           WHERE mos.delivered_at IS NOT NULL
             AND mos.recipient_provider = 'outlook'
             AND mos.unique_human_open = TRUE
         ) AS median_seconds_to_first_open
       FROM engagement.message_open_summary mos
       WHERE mos.sent_at >= NOW() - ($1::int * INTERVAL '1 day')
         AND (
           mos.dispatch_campaign_id IS NOT NULL
           OR mos.sendy_campaign_id IS NOT NULL
         )
       GROUP BY
         mos.tenant_id,
         mos.dispatch_campaign_id,
         mos.sendy_campaign_id,
         mos.sending_domain
     )
     SELECT
       cm.tenant_id,
       t.tenant_key,
       cm.dispatch_campaign_id,
       cm.sendy_campaign_id,
       cm.sending_domain,
       cm.first_sent_at,
       cm.last_sent_at,
       cm.delivered_messages,
       cm.unique_human_opens,
       cm.open_rate_pct,
       cm.avg_seconds_to_first_open,
       cm.median_seconds_to_first_open,
       ccs.subject,
       ccs.from_name,
       ccs.from_email
     FROM campaign_metrics cm
     JOIN control_plane.tenants t
       ON t.tenant_id = cm.tenant_id
     LEFT JOIN control_plane.sendy_campaign_registry r
       ON r.dispatch_campaign_id::text = cm.dispatch_campaign_id::text
     LEFT JOIN control_plane.campaign_content_snapshots ccs
       ON ccs.content_snapshot_id = r.content_snapshot_id
     ORDER BY t.tenant_key, cm.last_sent_at DESC`,
    [DAYS]
  );

  return result.rows;
}

function groupByTenant(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.tenant_key)) map.set(row.tenant_key, []);
    map.get(row.tenant_key).push(row);
  }

  return [...map.entries()];
}

function tenantSummary(rows) {
  const delivered = rows.reduce((sum, r) => sum + Number(r.delivered_messages || 0), 0);
  const opens = rows.reduce((sum, r) => sum + Number(r.unique_human_opens || 0), 0);
  const rate = delivered > 0 ? (100 * opens) / delivered : 0;

  return {
    campaigns: rows.length,
    delivered,
    opens,
    rate,
  };
}

function buildHtml(rows) {
  const groups = groupByTenant(rows);
  const generatedAt = fmtDate(new Date());

  const body = groups.length
    ? groups
        .map(([tenant, campaigns]) => {
          const summary = tenantSummary(campaigns);
          const campaignRows = campaigns
            .map(
              (r) => `<tr>
                <td style="padding:10px;border-bottom:1px solid #ececec;">${escapeHtml(r.subject || 'Sin asunto disponible')}</td>
                <td style="padding:10px;border-bottom:1px solid #ececec;">${escapeHtml(r.sending_domain || '—')}</td>
                <td style="padding:10px;border-bottom:1px solid #ececec;text-align:right;">${escapeHtml(r.delivered_messages || 0)}</td>
                <td style="padding:10px;border-bottom:1px solid #ececec;text-align:right;">${escapeHtml(r.unique_human_opens || 0)}</td>
                <td style="padding:10px;border-bottom:1px solid #ececec;text-align:right;">${pct(r.open_rate_pct)}</td>
                <td style="padding:10px;border-bottom:1px solid #ececec;text-align:right;">${secondsLabel(r.median_seconds_to_first_open)}</td>
                <td style="padding:10px;border-bottom:1px solid #ececec;">${fmtDate(r.last_sent_at)}</td>
              </tr>`
            )
            .join('');

          return `<section style="margin:28px 0 36px;">
            <h2 style="margin:0 0 12px;font-size:20px;">${escapeHtml(tenant)}</h2>
            <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px;font-size:14px;">
              <span><strong>Campañas:</strong> ${summary.campaigns}</span>
              <span><strong>Entregados:</strong> ${summary.delivered}</span>
              <span><strong>Aperturas únicas:</strong> ${summary.opens}</span>
              <span><strong>Open rate:</strong> ${summary.rate.toFixed(2)}%</span>
            </div>
            <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;">
              <thead>
                <tr style="background:#f7f7f7;">
                  <th style="padding:10px;text-align:left;">Asunto</th>
                  <th style="padding:10px;text-align:left;">Dominio</th>
                  <th style="padding:10px;text-align:right;">Entregados</th>
                  <th style="padding:10px;text-align:right;">Aperturas</th>
                  <th style="padding:10px;text-align:right;">Open rate</th>
                  <th style="padding:10px;text-align:right;">Mediana apertura</th>
                  <th style="padding:10px;text-align:left;">Último envío</th>
                </tr>
              </thead>
              <tbody>${campaignRows}</tbody>
            </table>
          </section>`;
        })
        .join('')
    : `<p>No hubo campañas con identidad de campaña en los últimos ${DAYS} días.</p>`;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
</head>
<body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111;">
  <div style="max-width:1100px;margin:0 auto;padding:28px;">
    <div style="background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:24px;">
      <h1 style="margin:0 0 6px;font-size:26px;">PowerEmail · Reporte diario</h1>
      <p style="margin:0;color:#555;">Últimos ${DAYS} días · generado ${escapeHtml(generatedAt)}</p>
      ${body}
      <p style="margin-top:30px;color:#777;font-size:12px;">Fuente: PowerEmail Open Intelligence. Métricas de Outlook basadas en entregas registradas y aperturas humanas probables.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildText(rows) {
  const groups = groupByTenant(rows);
  const lines = [
    `PowerEmail - Reporte diario`,
    `Últimos ${DAYS} días`,
    '',
  ];

  for (const [tenant, campaigns] of groups) {
    const summary = tenantSummary(campaigns);
    lines.push(tenant.toUpperCase());
    lines.push(`Campañas: ${summary.campaigns}`);
    lines.push(`Entregados: ${summary.delivered}`);
    lines.push(`Aperturas únicas: ${summary.opens}`);
    lines.push(`Open rate: ${summary.rate.toFixed(2)}%`);
    lines.push('');

    for (const r of campaigns) {
      lines.push(`- ${r.subject || 'Sin asunto disponible'}`);
      lines.push(`  ${r.sending_domain || '—'} · ${r.delivered_messages || 0} entregados · ${r.unique_human_opens || 0} aperturas · ${pct(r.open_rate_pct)}`);
    }

    lines.push('');
  }

  if (groups.length === 0) {
    lines.push(`No hubo campañas con identidad de campaña en los últimos ${DAYS} días.`);
  }

  return lines.join('\n');
}

async function main() {
  const pool = buildPool();

  try {
    const rows = await fetchCampaignRows(pool);
    const html = buildHtml(rows);
    const text = buildText(rows);
    const transporter = buildTransport();

    await transporter.verify();

    const subject = `PowerEmail · Reporte diario últimos ${DAYS} días · ${localDateLabel()}`;

    const info = await transporter.sendMail({
      from: REPORT_FROM,
      to: REPORT_TO,
      cc: REPORT_CC,
      subject,
      text,
      html,
    });

    console.log('[REPORT][SENT]', {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      tenants: groupByTenant(rows).length,
      campaigns: rows.length,
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[REPORT][ERROR]', error.stack || error.message);
  process.exit(1);
});
