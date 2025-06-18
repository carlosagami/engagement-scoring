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

const createLeadsInSmartlead = async () => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE smartlead_id IS NULL');

    for (const lead of rows) {
      const { email, segment, first_name, last_name } = lead;
      console.log(`🆕 Creando lead en Smartlead para: ${email}`);

      try {
        const response = await axios.post(
          `${SMARTLEAD_BASE_URL}/leads`,
          {
            email,
            first_name: first_name || '',
            last_name: last_name || '',
            custom_fields: { segment: segment || 'activo' }
          },
          {
            headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
          }
        );

        const smartleadId = response.data?.data?.id;
        if (smartleadId) {
          await pool.query('UPDATE leads SET smartlead_id = $1 WHERE email = $2', [smartleadId, email]);
          console.log(`✅ Lead creado y actualizado: ${email} → ID: ${smartleadId}`);
        } else {
          console.warn(`⚠️ Respuesta sin ID para ${email}`);
        }
      } catch (err) {
        console.warn(`❌ Error creando lead ${email}:`, err.response?.data || err.message);
      }
    }

    console.log('🎯 Sincronización de leads globales finalizada.');
  } catch (err) {
    console.error('❌ Error general:', err.message);
  }
};

module.exports = { createLeadsInSmartlead };
