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

const getCampaigns = async () => {
  try {
    const resp = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns`, {
      headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
    });
    console.log('🧪 Campañas recibidas:', JSON.stringify(resp.data, null, 2));
    return resp.data?.data;
  } catch (err) {
    console.error('❌ Error obteniendo campañas:', err.response?.data || err.message);
    throw new Error('No se pudo obtener la lista de campañas');
  }
};

const getLeadsFromCampaign = async (campaignId) => {
  try {
    const resp = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns/${campaignId}/leads`, {
      headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
    });
    return resp.data?.data || [];
  } catch (err) {
    console.error(`❌ Error obteniendo leads de campaña ${campaignId}:`, err.response?.data || err.message);
    return [];
  }
};

const syncLeadIdsFromCampaigns = async () => {
  try {
    const campaigns = await getCampaigns();

    if (!Array.isArray(campaigns)) {
      throw new Error('La respuesta de campañas no es un arreglo');
    }

    for (const campaign of campaigns) {
      const campaignId = campaign.id;
      const leads = await getLeadsFromCampaign(campaignId);

      for (const lead of leads) {
        const email = lead.email;
        const id = lead.id;

        const existing = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
        if (existing.rowCount === 0) continue;

        await pool.query(
          'UPDATE leads SET smartlead_id = $1 WHERE email = $2',
          [id, email]
        );

        console.log(`✅ Sync ID para ${email} → ${id}`);
      }
    }

    console.log('🎯 Sincronización de Smartlead IDs desde campañas completada.');
  } catch (err) {
    console.error('❌ Error sincronizando Smartlead IDs:', err.message);
    throw err;
  }
};

module.exports = { syncLeadIdsFromCampaigns };
