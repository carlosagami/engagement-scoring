// sync-lead-ids-from-campaigns.js
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

const syncLeadIdsFromCampaigns = async () => {
  try {
    // 1. Obtener campañas activas
    const response = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns`, {
      headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
    });

    const campaigns = response.data?.data;
    if (!Array.isArray(campaigns)) {
      throw new Error('La respuesta de campañas no es un arreglo');
    }

    console.log(`🔍 ${campaigns.length} campañas encontradas`);

    // 2. Iterar por campañas y sus leads
    for (const campaign of campaigns) {
      const campaignId = campaign.id;

      const leadsResp = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns/${campaignId}/leads`, {
        headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
      });

      const leads = leadsResp.data?.data || [];

      for (const lead of leads) {
        const email = lead.email;
        const id = lead.id;

        // 3. Guardar smartlead_id en nuestra base si no está
        const result = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);

        if (result.rows.length && !result.rows[0].smartlead_id) {
          await pool.query(
            'UPDATE leads SET smartlead_id = $1 WHERE email = $2',
            [id, email]
          );
          console.log(`✅ ID sincronizado: ${email} → ${id}`);
        }
      }
    }

    console.log('🎯 Sincronización de Smartlead IDs desde campañas completada.');
  } catch (err) {
    console.error('❌ Error sincronizando Smartlead IDs:', err.response?.data || err.message);
    throw err;
  }
};

module.exports = { syncLeadIdsFromCampaigns };
