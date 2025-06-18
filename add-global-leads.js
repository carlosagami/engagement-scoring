// Archivo: add-global-leads.js

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

const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
const SMARTLEAD_BASE_URL = 'https://app.smartlead.ai/api/v1';

const addGlobalLeads = async () => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE smartlead_id IS NULL');
    if (rows.length === 0) {
      console.log('✅ No hay leads pendientes de agregar.');
      return;
    }

    const payload = rows.map(lead => ({
      email: lead.email,
      first_name: lead.first_name || '',
      last_name: lead.last_name || ''
    }));

    console.log(`🚀 Enviando ${payload.length} leads globales a Smartlead...`);

    const response = await axios.post(
      `${SMARTLEAD_BASE_URL}/leads/bulk`,
      { leads: payload },
      { headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` } }
    );

    console.log('🎉 Leads agregados globalmente. Respuesta:', response.data);
  } catch (err) {
    console.error('❌ Error agregando leads globales:', err.response?.data || err.message);
  }
};

module.exports = { addGlobalLeads };
