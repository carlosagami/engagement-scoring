// sync-lead-ids.js

const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
const BASE_URL = 'https://server.smartlead.ai/api/v1';

// Obtiene todos los leads desde Smartlead (global)
async function fetchAllSmartleadLeads() {
  const resp = await axios.get(`${BASE_URL}/leads`, {
    headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
  });
  if (!Array.isArray(resp.data)) {
    throw new Error('La respuesta de leads globales no es un arreglo');
  }
  return resp.data; // { id, email, ... }
}

async function syncLeadIds() {
  const slLeads = await fetchAllSmartleadLeads();
  const local = await pool.query(
    'SELECT email FROM leads WHERE smartlead_id IS NULL'
  );

  const updates = [];
  local.rows.forEach(({ email }) => {
    const found = slLeads.find(l => l.email.toLowerCase() === email.toLowerCase());
    if (found) {
      updates.push({ email, id: found.id });
    }
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(
        'UPDATE leads SET smartlead_id = $1 WHERE email = $2',
        [u.id, u.email]
      );
      console.log('🔁 ID sincronizado:', u.email, '→', u.id);
    }
    await client.query('COMMIT');
    console.log(`✅ IDs actualizados: ${updates.length}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (updates.length === 0) {
    console.log('ℹ️ No había leads sin ID para actualizar');
  }
}

module.exports = syncLeadIds;
