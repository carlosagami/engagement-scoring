const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { Parser } = require('json2csv');
const axios = require('axios');

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

// Keep-alive ping
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

// Health check
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Webhook de aperturas
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

  const { event_type, to_email, event_timestamp } = req.body;

  if (!to_email) return res.status(400).send('Missing to_email');
  if (event_type !== 'EMAIL_OPEN') return res.status(200).send('IGNORED EVENT');

  const email = to_email.toLowerCase();
  const openDate = event_timestamp ? new Date(event_timestamp) : new Date();

  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    let lead = rows[0];
    let score = 2;
    let segment = 'activo';

    if (lead) {
      score = lead.score + 2;
      const lastOpen = new Date(lead.opens);
      const days = Math.floor((new Date() - lastOpen) / (1000 * 60 * 60 * 24));

      if (days >= 30 || score <= 0) segment = 'zombie';
      else if (days >= 14) segment = 'dormido';
      else if (score >= 10) segment = 'VIP';
    }

    await pool.query(
      `INSERT INTO leads (email, opens, score, segment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email)
       DO UPDATE SET opens = $2, score = $3, segment = $4`,
      [email, openDate, score, segment]
    );

    console.log(`📬 Lead actualizado: ${email} → ${segment} (score ${score})`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Error al guardar lead:', err.message);
    res.status(500).send('ERROR');
  }
});

// Ver leads como JSON
app.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');
    res.json(rows);
  } catch (err) {
    console.error('❌ Error al obtener leads:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Descargar leads en CSV
app.get('/export-leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');

    if (!rows.length) {
      return res.status(404).send('No hay leads para exportar.');
    }

    const parser = new Parser();
    const csv = parser.parse(rows);

    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    return res.send(csv);
  } catch (err) {
    console.error('❌ Error al exportar leads:', err.message);
    res.status(500).send('Error exportando CSV');
  }
});

// Iniciar servidor
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
