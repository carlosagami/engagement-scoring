// Archivo: sync-lead-ids-from-campaigns.js
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
    const campaignResp = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns`, {
      headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
    });

    const campaigns = campaignResp.data?.data;
    if (!Array.isArray(campaigns)) throw new Error('La respuesta de campañas no es un arreglo');

    console.log(`📦 ${campaigns.length} campañas obtenidas`);

    for (const campaign of campaigns) {
      const campaignId = campaign.id;
      const campaignName = campaign.name;

      console.log(`🔍 Leyendo leads de campaña: ${campaignName}`);

      const leadsResp = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns/${campaignId}/leads`, {
        headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
      });

      const leads = leadsResp.data?.data || [];

      for (const lead of leads) {
        const email = lead.email;
        const id = lead.id;

        if (!email || !id) continue;

        await pool.query(
          `UPDATE leads SET smartlead_id = $1 WHERE email = $2 AND smartlead_id IS NULL`,
          [id, email]
        );

        console.log(`✅ ${email} → ID: ${id}`);
      }
    }

    console.log('🎯 Sincronización de Smartlead IDs desde campañas finalizada.');
  } catch (err) {
    console.error('❌ Error sincronizando Smartlead IDs:', err.response?.data || err.message);
    throw err;
  }
};

module.exports = { syncLeadIdsFromCampaigns };
