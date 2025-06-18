// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const syncLeadIds = require('./sync-lead-ids'); // ✅ Importación correcta

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// PostgreSQL pool setup
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Keep-alive ping (cada 25 segundos)
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

// Health check
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Endpoint manual para sincronizar Smartlead IDs
app.get('/sync-lead-ids', async (req, res) => {
  try {
    await syncLeadIds();
    res.send('✅ IDs sincronizados correctamente desde Smartlead');
  } catch (err) {
    console.error('❌ Error al sincronizar IDs desde Smartlead:', err.message);
    res.status(500).send('❌ Error al sincronizar IDs desde Smartlead');
  }
});

// Inicia servidor y prueba conexión a PostgreSQL
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
