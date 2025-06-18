// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const axios = require('axios');

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

// 🔍 Prueba temporal: ver si la API Key se está leyendo
app.get('/check-env', (req, res) => {
  const key = process.env.SMARTLEAD_API_KEY;
  if (key) {
    res.send(`✅ SMARTLEAD_API_KEY cargada: ${key}`);
  } else {
    res.send('❌ SMARTLEAD_API_KEY no está definida en el entorno');
  }
});

// 🔐 Probar acceso real a la API de Smartlead
app.get('/test-smartlead-key', async (req, res) => {
  try {
    const result = await axios.get('https://server.smartlead.ai/api/v1/leads', {
      headers: {
        Authorization: `Bearer ${process.env.SMARTLEAD_API_KEY}`
      }
    });
    res.send(`✅ Smartlead API respondió OK. Total: ${result.data?.length ?? 0} leads`);
  } catch (err) {
    console.error('❌ Error al probar Smartlead API:', err?.response?.data || err.message);
    res.status(500).send(`❌ Error al probar Smartlead API: ${JSON.stringify(err?.response?.data || err.message)}`);
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
