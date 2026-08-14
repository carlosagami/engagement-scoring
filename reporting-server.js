const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const PORT = Number(process.env.REPORTING_PORT || process.env.PORT || 8080);
const REPORTING_READ_TOKEN = String(process.env.REPORTING_READ_TOKEN || '').trim();
const REPORTING_TIMEZONE = String(
  process.env.REPORTING_TIMEZONE || 'America/Mexico_City'
).trim();

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

function clampDays(value) {
  const parsed = Number.parseInt(String(value || '7'), 10);

  if (!Number.isFinite(parsed)) return 7;

  return Math.min(Math.max(parsed, 1), 90);
}

function normalizeFilter(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  return text;
}

function resolveDateRange(query) {
  const start = normalizeDate(query.start);
  const end = normalizeDate(query.end);

  if (start || end) {
    return {
      mode: 'range',
      start,
      end,
      days: null,
    };
  }

  return {
    mode: 'days',
    start: null,
    end: null,
    days: clampDays(query.days),
  };
}

function requireReadAccess(req, res, next) {
  if (!REPORTING_READ_TOKEN) {
    return next();
  }

  const authHeader = String(req.get('authorization') || '').trim();
  const explicitToken = String(req.get('x-reporting-token') || '').trim();

  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (
    bearer === REPORTING_READ_TOKEN ||
    explicitToken === REPORTING_READ_TOKEN
  ) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: 'unauthorized',
  });
}

app.use('/api', requireReadAccess);

app.get('/health', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        to_regclass('engagement.message_open_summary') IS NOT NULL AS message_open_summary_ready,
        to_regclass('engagement.outlook_campaign_open_rate_summary') IS NOT NULL AS campaign_summary_ready
    `);

    const row = result.rows[0] || {};
    const ready =
      row.message_open_summary_ready === true &&
      row.campaign_summary_ready === true;

    return res.status(ready ? 200 : 503).json({
      ok: ready,
      service: 'poweremail-outlook-reporting',
      database: row.database || null,
      message_open_summary_ready: row.message_open_summary_ready === true,
      campaign_summary_ready: row.campaign_summary_ready === true,
    });
  } catch (error) {
    console.error('[HEALTH][ERROR]', error.message);

    return res.status(503).json({
      ok: false,
      service: 'poweremail-outlook-reporting',
    });
  }
});

app.get('/api/tenants', async (req, res) => {
  const range = resolveDateRange(req.query);
  const tenantKey = normalizeFilter(req.query.tenant);

  try {
    const result = await pool.query(
      `
      SELECT
        t.tenant_id,
        t.tenant_key,
        COUNT(DISTINCT mos.dispatch_campaign_id) FILTER (
          WHERE mos.dispatch_campaign_id IS NOT NULL
        ) AS campaigns,
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
          100.0 *
          COUNT(*) FILTER (
            WHERE mos.delivered_at IS NOT NULL
              AND mos.recipient_provider = 'outlook'
              AND mos.unique_human_open = TRUE
          )
          /
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
        ) AS median_seconds_to_first_open,
        MIN(mos.sent_at) AS first_sent_at,
        MAX(mos.sent_at) AS last_sent_at
      FROM engagement.message_open_summary mos
      JOIN control_plane.tenants t
        ON t.tenant_id = mos.tenant_id
      WHERE
        (
          (
            $1::text = 'days'
            AND mos.sent_at >= NOW() - ($2::int * INTERVAL '1 day')
          )
          OR
          (
            $1::text = 'range'
            AND ($3::date IS NULL OR mos.sent_at >= ($3::date::timestamp AT TIME ZONE $5))
            AND ($4::date IS NULL OR mos.sent_at < (($4::date + 1)::timestamp AT TIME ZONE $5))
          )
        )
        AND ($6::text IS NULL OR lower(t.tenant_key) = lower($6))
      GROUP BY
        t.tenant_id,
        t.tenant_key
      ORDER BY t.tenant_key
      `,
      [
        range.mode,
        range.days || 7,
        range.start,
        range.end,
        REPORTING_TIMEZONE,
        tenantKey,
      ]
    );

    return res.json({
      ok: true,
      range,
      timezone: REPORTING_TIMEZONE,
      rows: result.rows,
    });
  } catch (error) {
    console.error('[TENANTS][ERROR]', error.message);

    return res.status(500).json({
      ok: false,
      error: 'tenant_report_failed',
    });
  }
});

app.get('/api/campaigns', async (req, res) => {
  const range = resolveDateRange(req.query);
  const tenantKey = normalizeFilter(req.query.tenant);
  const sendingDomain = normalizeFilter(req.query.domain);

  try {
    const result = await pool.query(
      `
      WITH campaign_metrics AS (
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
            100.0 *
            COUNT(*) FILTER (
              WHERE mos.delivered_at IS NOT NULL
                AND mos.recipient_provider = 'outlook'
                AND mos.unique_human_open = TRUE
            )
            /
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
        WHERE
          (
            $1::text = 'days'
            AND mos.sent_at >= NOW() - ($2::int * INTERVAL '1 day')
          )
          OR
          (
            $1::text = 'range'
            AND ($3::date IS NULL OR mos.sent_at >= ($3::date::timestamp AT TIME ZONE $5))
            AND ($4::date IS NULL OR mos.sent_at < (($4::date + 1)::timestamp AT TIME ZONE $5))
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
        ccs.from_email,
        r.created_at AS campaign_registered_at,
        r.updated_at AS campaign_updated_at
      FROM campaign_metrics cm
      JOIN control_plane.tenants t
        ON t.tenant_id = cm.tenant_id
      LEFT JOIN control_plane.sendy_campaign_registry r
        ON r.dispatch_campaign_id::text = cm.dispatch_campaign_id::text
      LEFT JOIN control_plane.campaign_content_snapshots ccs
        ON ccs.content_snapshot_id = r.content_snapshot_id
      WHERE ($6::text IS NULL OR lower(t.tenant_key) = lower($6))
        AND ($7::text IS NULL OR lower(cm.sending_domain) = lower($7))
        AND (
          cm.dispatch_campaign_id IS NOT NULL
          OR cm.sendy_campaign_id IS NOT NULL
        )
      ORDER BY
        cm.last_sent_at DESC,
        t.tenant_key,
        cm.dispatch_campaign_id DESC
      `,
      [
        range.mode,
        range.days || 7,
        range.start,
        range.end,
        REPORTING_TIMEZONE,
        tenantKey,
        sendingDomain,
      ]
    );

    return res.json({
      ok: true,
      range,
      timezone: REPORTING_TIMEZONE,
      rows: result.rows,
    });
  } catch (error) {
    console.error('[CAMPAIGNS][ERROR]', error.message);

    return res.status(500).json({
      ok: false,
      error: 'campaign_report_failed',
    });
  }
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PowerEmail Outlook Reporting</title>
  <style>
    :root {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      margin: 0;
      background: #f5f5f5;
      color: #111;
    }

    .wrap {
      max-width: 1400px;
      margin: 0 auto;
      padding: 28px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 28px;
    }

    .sub {
      margin: 0 0 24px;
      color: #555;
    }

    .filters {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }

    input,
    select,
    button {
      font: inherit;
      padding: 10px 12px;
      border: 1px solid #ccc;
      border-radius: 8px;
      background: white;
    }

    button {
      cursor: pointer;
      font-weight: 600;
    }

    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }

    .card {
      background: white;
      border-radius: 12px;
      padding: 16px;
      border: 1px solid #e6e6e6;
    }

    .card .label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    .card .value {
      font-size: 28px;
      font-weight: 700;
      margin-top: 6px;
    }

    .table-wrap {
      background: white;
      border: 1px solid #e6e6e6;
      border-radius: 12px;
      overflow: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1200px;
    }

    th,
    td {
      padding: 12px;
      border-bottom: 1px solid #eee;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }

    th {
      background: #fafafa;
      position: sticky;
      top: 0;
      z-index: 1;
      font-size: 12px;
      text-transform: uppercase;
      color: #555;
    }

    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }

    .empty {
      padding: 28px;
      color: #666;
    }

    @media (max-width: 900px) {
      .cards {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .wrap {
        padding: 16px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>PowerEmail · Outlook Reporting</h1>
    <p class="sub">Campañas, entregas y aperturas humanas probables.</p>

    <div class="filters">
      <select id="days">
        <option value="7">Últimos 7 días</option>
        <option value="14">Últimos 14 días</option>
        <option value="30">Últimos 30 días</option>
        <option value="custom">Rango personalizado</option>
      </select>

      <input id="start" type="date" aria-label="Desde">
      <input id="end" type="date" aria-label="Hasta">
      <input id="tenant" placeholder="Tenant, ej. shopology">
      <input id="domain" placeholder="Dominio, ej. servireselcamino.com">
      <input id="accessToken" type="password" placeholder="Token de acceso">
      <button id="refresh">Actualizar</button>
    </div>

    <div class="cards">
      <div class="card">
        <div class="label">Campañas</div>
        <div class="value" id="campaigns">0</div>
      </div>
      <div class="card">
        <div class="label">Entregados</div>
        <div class="value" id="delivered">0</div>
      </div>
      <div class="card">
        <div class="label">Aperturas únicas</div>
        <div class="value" id="opens">0</div>
      </div>
      <div class="card">
        <div class="label">Open rate</div>
        <div class="value" id="rate">0%</div>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Tenant</th>
            <th>Asunto</th>
            <th>Dominio</th>
            <th>Fecha</th>
            <th>Entregados</th>
            <th>Unique Opens</th>
            <th>Open Rate</th>
            <th>Promedio apertura</th>
            <th>Mediana apertura</th>
            <th>Último envío</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="empty" class="empty" hidden>No hay campañas para estos filtros.</div>
    </div>
  </div>

  <script>
    function secondsLabel(value) {
      const seconds = Number(value);

      if (!Number.isFinite(seconds)) return '—';

      if (seconds < 60) {
        return seconds.toFixed(1) + ' s';
      }

      const minutes = Math.floor(seconds / 60);
      const remaining = Math.round(seconds % 60);

      return minutes + 'm ' + remaining + 's';
    }

    function dateLabel(value) {
      if (!value) return '—';

      const d = new Date(value);

      if (Number.isNaN(d.getTime())) return '—';

      return d.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    async function load() {
      const days = document.getElementById('days').value;
      const start = document.getElementById('start').value;
      const end = document.getElementById('end').value;
      const tenant = document.getElementById('tenant').value.trim();
      const domain = document.getElementById('domain').value.trim();
      const tokenInput = document.getElementById('accessToken');
      const token = tokenInput.value.trim() || sessionStorage.getItem('reportingToken') || '';

      if (tokenInput.value.trim()) {
        sessionStorage.setItem('reportingToken', tokenInput.value.trim());
      }

      const params = new URLSearchParams();

      if (days === 'custom') {
        if (start) params.set('start', start);
        if (end) params.set('end', end);
      } else {
        params.set('days', days);
      }

      if (tenant) params.set('tenant', tenant);
      if (domain) params.set('domain', domain);

      const headers = token
        ? { Authorization: 'Bearer ' + token }
        : {};

      const response = await fetch(
        '/api/campaigns?' + params.toString(),
        { headers }
      );

      if (response.status === 401) {
        throw new Error('Token de acceso inválido o faltante');
      }

      if (!response.ok) {
        throw new Error('No se pudo cargar el reporte');
      }

      const payload = await response.json();
      const rows = payload.rows || [];

      const delivered = rows.reduce(
        (sum, row) => sum + Number(row.delivered_messages || 0),
        0
      );

      const opens = rows.reduce(
        (sum, row) => sum + Number(row.unique_human_opens || 0),
        0
      );

      const rate = delivered > 0
        ? (100 * opens / delivered).toFixed(2)
        : '0.00';

      document.getElementById('campaigns').textContent = rows.length;
      document.getElementById('delivered').textContent = delivered;
      document.getElementById('opens').textContent = opens;
      document.getElementById('rate').textContent = rate + '%';

      const tbody = document.getElementById('rows');
      const empty = document.getElementById('empty');

      tbody.innerHTML = '';

      if (rows.length === 0) {
        empty.hidden = false;
        return;
      }

      empty.hidden = true;

      for (const row of rows) {
        const tr = document.createElement('tr');

        tr.innerHTML = \`
          <td>\${escapeHtml(row.tenant_key || '')}</td>
          <td>\${escapeHtml(row.subject || 'Sin asunto disponible')}</td>
          <td>\${escapeHtml(row.sending_domain || '')}</td>
          <td>\${escapeHtml(dateLabel(row.last_sent_at))}</td>
          <td>\${escapeHtml(row.delivered_messages || 0)}</td>
          <td>\${escapeHtml(row.unique_human_opens || 0)}</td>
          <td>\${escapeHtml(row.open_rate_pct || 0)}%</td>
          <td>\${escapeHtml(secondsLabel(row.avg_seconds_to_first_open))}</td>
          <td>\${escapeHtml(secondsLabel(row.median_seconds_to_first_open))}</td>
          <td>\${escapeHtml(dateLabel(row.last_sent_at))}</td>
        \`;

        tbody.appendChild(tr);
      }
    }

    const daysSelect = document.getElementById('days');
    const startInput = document.getElementById('start');
    const endInput = document.getElementById('end');
    const tokenInput = document.getElementById('accessToken');

    tokenInput.value = sessionStorage.getItem('reportingToken') || '';

    function syncDateInputs() {
      const custom = daysSelect.value === 'custom';
      startInput.disabled = !custom;
      endInput.disabled = !custom;
    }

    daysSelect.addEventListener('change', syncDateInputs);
    syncDateInputs();

    document.getElementById('refresh').addEventListener('click', () => {
      load().catch((error) => {
        alert(error.message);
      });
    });

    if (tokenInput.value) {
      load().catch((error) => {
        console.error(error);
      });
    }
  </script>
</body>
</html>`);
});

app.use((_req, res) => {
  res.status(404).type('text/plain').send('not found');
});

const server = app.listen(PORT, async () => {
  console.log('[BOOT] poweremail-outlook-reporting listening on ' + PORT);

  try {
    await pool.query('SELECT 1');
    console.log('[DB] connected');
  } catch (error) {
    console.error('[DB][ERROR]', error.message);
  }
});

async function shutdown(signal) {
  console.log('[SYS] ' + signal + ' received');

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
