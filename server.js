// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
const port = process.env.PORT || 8080;

app.use(express.json()); // <-- necesario para procesar JSON de webhooks

// PostgreSQL connection
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Webhook para eventos de apertura de Smartlead
app.post('/webhook', async (req, res) => {
  const { to_email, event_type, event_timestamp } = req.body;

  if (!to_email || event_type !== 'EMAIL_OPEN') {
    return res.status(200).send('Evento ignorado');
  }

  const email = to_email;
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
    console.error('❌ Error al actualizar lead:', err.message);
    res.status(500).send('ERROR');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Keep-alive ping
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25000);

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
