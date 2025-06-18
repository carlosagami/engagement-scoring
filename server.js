// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const axios = require('axios');
const dayjs = require('dayjs');
const json2csv = require('json2csv').parse;

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Keep-alive ping
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

app.post('/webhook', async (req, res) => {
  const payload = req.body;
  const email = payload?.lead?.email;
  const type = payload?.event_type?.toLowerCase();

  if (!email || !type) {
    return res.status(400).send('Missing email or event type');
  }

  const client = await pool.connect();
  try {
    const leadRes = await client.query('SELECT * FROM leads WHERE email = $1', [email]);
    if (leadRes.rowCount === 0) {
      console.log('❌ Lead no encontrado:', email);
      return res.status(404).send('Lead not found');
    }

    const lead = leadRes.rows[0];
    let updates = [];
    const now = dayjs().format('YYYY-MM-DD');

    if (type === 'email sent') {
      updates.push("send_count = COALESCE(send_count, 0) + 1", `last_sent = '${now}'`);
    } else if (type === 'email open') {
      updates.push("open_count = COALESCE(open_count, 0) + 1", `last_open = '${now}'`, "score = score + 1");
    } else if (type === 'email link click') {
      updates.push("click_count = COALESCE(click_count, 0) + 1", `last_click = '${now}'`, "score = score + 2");
    } else if (type === 'email reply') {
      updates.push(`last_reply = '${now}'`, "score = score + 3");
    }

    // Clasificación según puntuación y última actividad
    let segment = lead.segment;
    const score = lead.score + (type === 'email open' ? 1 : type === 'email link click' ? 2 : type === 'email reply' ? 3 : 0);
    const daysSinceOpen = lead.last_open ? dayjs().diff(lead.last_open, 'day') : Infinity;

    if (score >= 6 && daysSinceOpen <= 7) {
      segment = 'vip';
    } else if (score >= 3 && daysSinceOpen <= 30) {
      segment = 'activo';
    } else if (score > 0 && daysSinceOpen <= 60) {
      segment = 'dormido';
    } else {
      segment = 'zombie';
    }
    updates.push(`segment = '${segment}'`);

    await client.query(`UPDATE leads SET ${updates.join(', ')} WHERE email = $1`, [email]);
    console.log(`📬 Lead actualizado: ${email} → ${segment}`);
    res.send('OK');
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
    res.status(500).send('Internal server error');
  } finally {
    client.release();
  }
});

// CSV export
app.get('/download', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads');
    const csv = json2csv(result.rows);
    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    return res.send(csv);
  } catch (err) {
    console.error('❌ Error exportando CSV:', err.message);
    res.status(500).send('Error exportando CSV');
  }
});

// Start server
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
