const { Pool } = require('pg');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

const API_KEY = process.env.SMARTLEAD_API_KEY;
const BASE = 'https://server.smartlead.ai/api/v1';

const getTagForLead = (lead) => {
  const now = new Date();
  const lastOpen = new Date(lead.opens);
  const days = Math.floor((now - lastOpen) / (1000 * 60 * 60 * 24));
  if (days >= 30 || lead.score <= 0) return 'zombie';
  if (days >= 15) return 'dormido';
  if (lead.score >= 10) return 'vip';
  return 'activo';
};

async function syncTags() {
  const { rows } = await pool.query('SELECT * FROM leads');
  for (const lead of rows) {
    const tag = getTagForLead(lead);
    console.log(`🔁 ${lead.email} → ${tag}`);

    // Obtener lead_id
    const getRes = await axios.get(
      `${BASE}/leads?email=${encodeURIComponent(lead.email)}&api_key=${API_KEY}`
    );
    if (!getRes.data || !getRes.data.leads || getRes.data.leads.length === 0) {
      console.warn(`⚠️ Lead no encontrado en Smartlead: ${lead.email}`);
      continue;
    }
    const leadId = getRes.data.leads[0].id;

    // Actualizar tags
    await axios.post(
      `${BASE}/leads/${leadId}/update-tags?api_key=${API_KEY}`,
      { addTags: [tag] },
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
  console.log('✅ Tags sincronizadas.');
}

module.exports = { syncTags };
