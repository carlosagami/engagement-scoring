const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { syncCategories } = require('./sync-categories');
const { syncLeadIdsFromCampaigns } = require('./sync-lead-ids-from-campaigns');

dotenv.config();
const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('✅ Conexión exitosa a PostgreSQL'))
  .catch(err => {
    console.error('❌ Error de conexión a PostgreSQL:', err.message);
    process.exit(1);
  });

// Webhook de Smartlead (ej: aperturas)
app.post('/webhook', async (req, res) => {
  const { event_type, to_email, event_timestamp } = req.body;
  if (!to_email) return res.status(400).send('Missing to_email');
  if (event_type !== 'EMAIL_OPEN') return res.status(200).send('IGNORED EVENT');

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

    console.log(`✅ Lead actualizado: ${email} → ${segment}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Error al guardar lead:', err.message);
    res.status(500).send('ERROR');
  }
});

app.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/sync-categories', async (req, res) => {
  try {
    await syncCategories();
    res.send('✅ Categorías sincronizadas correctamente');
  } catch (err) {
    console.error('❌ Error al sincronizar categorías:', err.message);
    res.status(500).send('❌ Error al sincronizar categorías');
  }
});

app.get('/sync-ids-campaigns', async (req, res) => {
  try {
    await syncLeadIdsFromCampaigns();
    res.send('✅ IDs sincronizados desde campañas');
  } catch (err) {
    console.error('❌ Error al sincronizar IDs desde campañas:', err.message);
    res.status(500).send('❌ Error al sincronizar IDs desde campañas');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Engagement Scoring API Viva');
});

setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API corriendo en puerto ${PORT}`);
});
