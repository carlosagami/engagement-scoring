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

const getAllCampaigns = async () => {
  const res = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns`, {
    headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
  });
  return res.data.data;
};

const getLeadsFromCampaign = async (campaignId) => {
  const res = await axios.get(`${SMARTLEAD_BASE_URL}/campaigns/${campaignId}/leads`, {
    headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
  });
  return res.data.data;
};

const syncLeadIdsFromCampaigns = async () => {
  try {
    const { rows: localLeads } = await pool.query('SELECT * FROM leads WHERE smartlead_id IS NULL');
    const emailsToUpdate = new Set(localLeads.map(l => l.email));

    const campaigns = await getAllCampaigns();
    let updatedCount = 0;

    for (const campaign of campaigns) {
      const leads = await getLeadsFromCampaign(campaign.id);

      for (const lead of leads) {
        if (emailsToUpdate.has(lead.email)) {
          await pool.query(
            'UPDATE leads SET smartlead_id = $1 WHERE email = $2',
            [lead.id, lead.email]
          );
          console.log(`✅ ID sincronizado: ${lead.email} → ${lead.id}`);
          updatedCount++;
        }
      }
    }

    console.log(`🎯 Sincronización terminada. Leads actualizados: ${updatedCount}`);
  } catch (err) {
    console.error('❌ Error sincronizando Smartlead IDs:', err.response?.data || err.message);
  }
};

syncLeadIdsFromCampaigns();
