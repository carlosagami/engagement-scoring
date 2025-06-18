// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const syncLeadIds = require('./sync-lead-ids');
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

// Endpoint para probar si la API Key de Smartlead es válida
app.get('/test-smartlead-key', async (req, res) => {
  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
  const BASE_URL = 'https://server.smartlead.ai/api/v1';

  try {
    const response = await axios.get(`${BASE_URL}/leads`, {
      headers: {
        Authorization: `Bearer ${SMARTLEAD_API_KEY}`
      }
    });

    if (!Array.isArray(response.data)) {
      throw new Error('La respuesta no es un arreglo válido de leads');
    }

    res.send(`✅ ¡API Key válida! Leads obtenidos: ${response.data.length}`);
  } catch (error) {
    const msg = error.response?.data || error.message;
    res.status(500).send(`❌ Error al probar Smartlead API: ${msg}`);
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
