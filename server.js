const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const axios = require('axios');
const { Parser } = require('json2csv');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('✅ Engagement Scoring API funcionando correctamente');
});

// Exportar leads como CSV
app.get('/leads/csv', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');
    const parser = new Parser();
    const csv = parser.parse(rows);
    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    res.send(csv);
  } catch (err) {
    console.error('❌ Error exportando CSV:', err.message);
    res.status(500).send('Error exportando CSV');
  }
});

// Webhook de Smartlead
app.post('/webhook', async (req, res) => {
  const { event_type, to_email, event_timestamp } = req.body;
  if (!to_email) return res.status(400).send('Email faltante');

  const email = to_email.toLowerCase();
  const event = event_type;
  const timestamp = event_timestamp ? new Date(event_timestamp) : new Date();

  let scoreDelta = 0;
  let openIncrement = 0;
  let clickIncrement = 0;

  switch (event) {
    case 'EMAIL_OPEN':
      scoreDelta = 2;
      openIncrement = 1;
      break;
    case 'EMAIL_CLICK':
      scoreDelta = 4;
      clickIncrement = 1;
      break;
    case 'EMAIL_REPLY':
      scoreDelta = 10;
      break;
    default:
      return res.status(200).send('Evento ignorado');
  }

  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    const lead = rows[0];
    let score = scoreDelta;
    let openCount = openIncrement;
    let clickCount = clickIncrement;
    let lastOpen = event === 'EMAIL_OPEN' ? timestamp : null;
    let lastClick = event === 'EMAIL_CLICK' ? timestamp : null;
    let lastReply = event === 'EMAIL_REPLY' ? timestamp : null;

    if (lead) {
      score += lead.score;
      openCount += lead.open_count || 0;
      clickCount += lead.click_count || 0;
      lastOpen = event === 'EMAIL_OPEN' ? timestamp : lead.last_open;
      lastClick = event === 'EMAIL_CLICK' ? timestamp : lead.last_click;
      lastReply = event === 'EMAIL_REPLY' ? timestamp : lead.last_reply;
    }

    // Clasificación
    const lastActivity = lastReply || lastClick || lastOpen || timestamp;
    const daysSince = Math.floor((Date.now() - new Date(lastActivity)) / (1000 * 60 * 60 * 24));
    let segment = 'zombie';

    if (daysSince <= 7 && score >= 10) segment = 'VIP';
    else if (daysSince <= 14 && score >= 4) segment = 'activo';
    else if (daysSince <= 30 && score >= 1) segment = 'dormido';

    await pool.query(
      `INSERT INTO leads (email, score, open_count, click_count, last_open, last_click, last_reply, segment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email)
       DO UPDATE SET
         score = $2,
         open_count = $3,
         click_count = $4,
         last_open = $5,
         last_click = $6,
         last_reply = $7,
         segment = $8`,
      [email, score, openCount, clickCount, lastOpen, lastClick, lastReply, segment]
    );

    console.log(`📬 ${event} registrado para ${email} → ${segment} (${score} pts)`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
    res.status(500).send('ERROR');
  }
});

// Keep-alive
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
