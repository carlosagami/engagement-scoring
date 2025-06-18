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
      last_name: lead.last_name || '',
      custom_fields: {
        opens: lead.opens?.toISOString?.() || null,
        score: lead.score?.toString?.() || '0',
        segment: lead.segment || 'desconocido'
      }
    }));

    console.log(`🚀 Enviando ${payload.length} leads globales a Smartlead...`);

    const response = await axios.post(
      `${SMARTLEAD_BASE_URL}/leads/bulk`,
      { leads: payload },
      { headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` } }
    );

    const created = response.data?.data;

    if (!Array.isArray(created)) {
      throw new Error('La respuesta de Smartlead no contiene un array de leads.');
    }

    // Guarda los IDs devueltos en la base de datos
    for (const lead of created) {
      if (lead.email && lead.id) {
        await pool.query(
          'UPDATE leads SET smartlead_id = $1 WHERE email = $2',
          [lead.id, lead.email]
        );
        console.log(`✅ Guardado: ${lead.email} → ID: ${lead.id}`);
      }
    }

    console.log('🎯 Leads globales agregados y actualizados correctamente.');
  } catch (err) {
    console.error('❌ Error agregando leads globales:', err.response?.data || err.message);
  }
};

module.exports = { addGlobalLeads };
