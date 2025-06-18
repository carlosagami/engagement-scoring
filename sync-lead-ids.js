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
const BASE_URL = 'https://app.smartlead.ai/api/v1';

// Verifica que sí existe una clave antes de llamar
if (!SMARTLEAD_API_KEY) {
  console.error('❌ SMARTLEAD_API_KEY no está definida en las variables de entorno');
}

async function fetchAllSmartleadLeads() {
  const resp = await axios.get(`${BASE_URL}/leads`, {
    headers: {
      Authorization: `Bearer ${SMARTLEAD_API_KEY}`
    }
  });

  if (!Array.isArray(resp.data?.data)) {
    throw new Error('La respuesta de Smartlead no contiene un arreglo válido en data.data');
  }

  return resp.data.data; // Smartlead wraps results in data.data
}

async function syncLeadIds() {
  const smartLeads = await fetchAllSmartleadLeads();

  const { rows } = await pool.query('SELECT email FROM leads WHERE smartlead_id IS NULL');
  const updates = [];

  for (const row of rows) {
    const found = smartLeads.find(l => l.email?.toLowerCase() === row.email.toLowerCase());
    if (found) {
      updates.push({ email: row.email, id: found.id });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const lead of updates) {
      await client.query(
        'UPDATE leads SET smartlead_id = $1 WHERE email = $2',
        [lead.id, lead.email]
      );
      console.log(`🔁 ID sincronizado: ${lead.email} → ${lead.id}`);
    }
    await client.query('COMMIT');
    console.log(`✅ ${updates.length} IDs sincronizados exitosamente.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error durante sincronización de IDs:', err.message);
    throw err;
  } finally {
    client.release();
  }

  if (updates.length === 0) {
    console.log('ℹ️ No se encontraron leads pendientes de ID.');
  }
}

module.exports = { syncLeadIds };
