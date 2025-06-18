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

const getCategoryForLead = (lead) => {
  const now = new Date();
  const lastOpen = new Date(lead.opens);
  const days = Math.floor((now - lastOpen) / (1000 * 60 * 60 * 24));

  if (days >= 30 || lead.score <= 0) return 'Zombie';
  if (days >= 15) return 'Dormido';
  if (lead.score >= 10) return 'VIP';
  return 'Activo';
};

const syncCategories = async () => {
  try {
    const { rows: leads } = await pool.query('SELECT * FROM leads');

    for (const lead of leads) {
      const email = lead.email;
      const category = getCategoryForLead(lead);

      console.log(`🔁 ${email} → ${category}`);

      try {
        // 1. Obtener el lead por email
        const getLeadResp = await axios.get(
          `${SMARTLEAD_BASE_URL}/leads?email=${encodeURIComponent(email)}&api_key=${SMARTLEAD_API_KEY}`
        );

        const leadData = getLeadResp.data?.data;
        if (!Array.isArray(leadData) || leadData.length === 0) {
          console.warn(`⚠️ Lead no encontrado en Smartlead: ${email}`);
          continue;
        }

        const leadId = leadData[0].id;
        if (!leadId) {
          console.warn(`⚠️ Lead sin ID válido: ${email}`);
          continue;
        }

        // 2. Actualizar categoría
        await axios.post(
          `${SMARTLEAD_BASE_URL}/leads/${leadId}/category`,
          { category_name: category },
          {
            headers: { Authorization: `Bearer ${SMARTLEAD_API_KEY}` }
          }
        );

        console.log(`✅ Categoría actualizada para ${email} → ${category}`);
      } catch (innerErr) {
        console.error(`❌ Error al procesar ${email}:`, innerErr.response?.data || innerErr.message);
      }
    }

    console.log('🎉 Sincronización de categorías completada.');
  } catch (err) {
    console.error('❌ Error general:', err.response?.data || err.message);
  }
};

module.exports = { syncCategories };
