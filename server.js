// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const axios = require('axios');
const syncLeadIds = require('./sync-lead-ids'); // 👈 Debes tener este archivo

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// PostgreSQL connection
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Webhook para registrar aperturas de email
app.use(express.json());
app.post('/webhook', async (req, res) => {
  const { event_type, to_email, event_timestamp } = req.body;
  if (!to_email) return res.status(400).send('Missing to_email');
  if (event_type !== 'EMAIL_OPEN') return res.status(200).send('IGNORED EVENT');

  const email = to_email;
  const openedAt = event_timestamp ? new Date(event_timestamp) : new Date();

  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    const lead = rows[0];
    let score = 2;
    let segment = 'activo';

    if (lead) {
      score = lead.score + 2;
      const daysSinceLastOpen = Math.floor((new Date() - new Date(lead.opens)) / (1000 * 60 * 60 * 24));
      if (daysSinceLastOpen >= 30 || score <= 0) segment = 'zombie';
      else if (daysSinceLastOpen >= 14) segment = 'dormido';
      else if (score >= 10) segment = 'VIP';
    }

    await pool.query(
      `INSERT INTO leads (email, opens, score, segment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email)
       DO UPDATE SET opens = $2, score = $3, segment = $4`,
      [email, openedAt, score, segment]
    );

    console.log(`✅ Lead actualizado: ${email} → ${segment}`);
    res.send('OK');
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
    res.status(500).send('ERROR');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Endpoint para sincronizar IDs desde Smartlead
app.get('/sync-lead-ids', async (req, res) => {
  try {
    await syncLeadIds();
    res.send('✅ IDs sincronizados correctamente desde Smartlead');
  } catch (err) {
    console.error('❌ Error al sincronizar IDs desde Smartlead:', err.message);
    res.status(500).send('❌ Error al sincronizar IDs desde Smartlead');
  }
});

// Probar si la API key de Smartlead funciona correctamente
app.get('/test-smartlead-key', async (req, res) => {
  try {
    const response = await axios.get(
      'https://server.smartlead.ai/api/v1/leads',
      {
        headers: { Authorization: `Bearer ${process.env.SMARTLEAD_API_KEY}` }
      }
    );

    res.send(`✅ Smartlead API Key válida. Leads encontrados: ${response.data.length}`);
  } catch (err) {
    console.error('❌ Error al probar Smartlead API:', err.response?.data || err.message);
    res.status(500).send(`❌ Error al probar Smartlead API: ${
      err.response?.data ? JSON.stringify(err.response.data) : err.message
    }`);
  }
});

// Keep-alive
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
