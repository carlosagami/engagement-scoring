// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const axios = require('axios');
const syncLeadIds = require('./sync-lead-ids');

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

// Keep-alive ping
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

// Health check
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Sincronización manual desde Smartlead
app.get('/sync-lead-ids', async (req, res) => {
  try {
    await syncLeadIds();
    res.send('✅ IDs sincronizados correctamente desde Smartlead');
  } catch (err) {
    console.error('❌ Error al sincronizar IDs desde Smartlead:', err.message);
    res.status(500).send('❌ Error al sincronizar IDs desde Smartlead');
  }
});

// Prueba de API Key de Smartlead con correo
app.get('/test-smartlead-key', async (req, res) => {
  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
  const testEmail = 'carlosagami@gmail.com'; // Cámbialo por un email real que esté en tu cuenta de Smartlead

  try {
    const response = await axios.get(
      `https://server.smartlead.ai/api/v1/leads?email=${encodeURIComponent(testEmail)}&api_key=${SMARTLEAD_API_KEY}`
    );

    const lead = response.data?.data?.[0];

    if (lead) {
      res.send(`✅ Lead encontrado: ${lead.email} → ID: ${lead.id}`);
    } else {
      res.send(`⚠️ Lead no encontrado para ${testEmail}`);
    }
  } catch (err) {
    console.error('❌ Error al probar Smartlead API:', err.response?.data || err.message);
    res
      .status(500)
      .send(`❌ Error al probar Smartlead API: ${JSON.stringify(err.response?.data || err.message)}`);
  }
});

// Arranque del servidor
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
