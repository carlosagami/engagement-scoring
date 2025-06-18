const { Pool } = require('pg');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

// Configura PostgreSQL
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Configura API Smartlead
const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
const SMARTLEAD_BASE_URL = 'https://app.smartlead.ai/api/v1';

const getTagForLead = (lead) => {
  const now = new Date();
  const lastOpen = new Date(lead.opens);
  const days = Math.floor((now - lastOpen) / (1000 * 60 * 60 * 24));

  if (days >= 30 || lead.score <= 0) return 'zombie';
  if (days >= 15) return 'dormido';
  if (lead.score >= 10) return 'vip';
  return 'activo';
};

const leadExists = async (email) => {
  try {
    const response = await axios.post(`${SMARTLEAD_BASE_URL}/contacts/email`, {
      email
    }, {
      headers: {
        Authorization: `Bearer ${SMARTLEAD_API_KEY}`
      }
    });

    return response.status === 200 && response.data?.id;
  } catch (err) {
    console.warn(`⚠️ Error consultando existencia del lead (${email}):`, err.response?.status || err.message);
    return false;
  }
};

const syncTags = async () => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');

    for (const lead of rows) {
      const tag = getTagForLead(lead);
      const email = lead.email;

      const exists = await leadExists(email);
      if (!exists) {
        console.warn(`⚠️ Lead no encontrado en Smartlead: ${email}`);
        continue;
      }

      // Opcional: limpiar los demás tags que no aplican
      const allTags = ['zombie', 'dormido', 'vip', 'activo'];
      const tagsToRemove = allTags.filter(t => t !== tag);

      console.log(`🔁 Syncing ${email} → ${tag}`);

      await axios.post(`${SMARTLEAD_BASE_URL}/contacts/tag`, {
        contactEmail: email,
        addTags: [tag],
        removeTags: tagsToRemove
      }, {
        headers: {
          Authorization: `Bearer ${SMARTLEAD_API_KEY}`
        }
      });
    }

    console.log('✅ Tags sincronizadas exitosamente');
  } catch (err) {
    console.error('❌ Error al sincronizar tags:', err.message);
    throw err;
  }
};

module.exports = { syncTags };
