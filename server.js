const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const axios = require('axios');
const syncLeadIds = require('./sync-lead-ids'); // asegúrate que esté bien exportado

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// PostgreSQL connection pool
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

// Verifica que se carga correctamente la API Key desde Railway
app.get('/check-env', (req, res) => {
  const key = process.env.SMARTLEAD_API_KEY;
  if (key) {
    res.send(`✅ SMARTLEAD_API_KEY cargada: ${key}`);
  } else {
    res.status(500).send('❌ SMARTLEAD_API_KEY no está definida');
  }
});

// Endpoint para sincronizar Smartlead IDs desde leads globales
app.get('/sync-lead-ids', async (req, res) => {
  try {
    await syncLeadIds();
    res.send('✅ IDs sincronizados correctamente desde Smartlead');
  } catch (err) {
    console.error('❌ Error al sincronizar IDs desde Smartlead:', err.message);
    res.status(500).send(`❌ Error al sincronizar IDs desde Smartlead: ${err.message}`);
  }
});

// Prueba si la API Key de Smartlead está funcionando correctamente
app.get('/test-smartlead-key', async (req, res) => {
  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;

  try {
    const response = await axios.get('https://server.smartlead.ai/api/v1/leads', {
      headers: {
        'Authorization': `Bearer ${SMARTLEAD_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const count = Array.isArray(response.data) ? response.data.length : '?';
    res.send(`✅ Smartlead API Key funciona. Leads visibles: ${count}`);
  } catch (err) {
    console.error('❌ Error al probar Smartlead API:', err.response?.data || err.message);
    res.status(500).send(`❌ Error al probar Smartlead API: ${JSON.stringify(err.response?.data || err.message)}`);
  }
});

// Inicializa el servidor
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
