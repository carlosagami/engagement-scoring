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

const syncLeadIds = async () => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE smartlead_id IS NULL');

    for (const lead of rows) {
      const email = lead.email;
      console.log(`🔍 Buscando Smartlead ID para ${email}`);

      const resp = await axios.get(
        `${SMARTLEAD_BASE_URL}/leads?email=${encodeURIComponent(email)}&api_key=${SMARTLEAD_API_KEY}`
      );

      const id = resp.data?.data?.[0]?.id;

      if (!id) {
        console.warn(`⚠️ No encontrado: ${email}`);
        continue;
      }

      await pool.query(
        'UPDATE leads SET smartlead_id = $1 WHERE email = $2',
        [id, email]
      );

      console.log(`✅ Actualizado: ${email} → ID: ${id}`);
    }

    console.log('🎯 Sincronización de Smartlead IDs finalizada.');
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
};

syncLeadIds();
