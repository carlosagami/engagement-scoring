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

const getTagForLead = (score, daysSinceLastOpen) => {
  if (daysSinceLastOpen >= 30 || score <= 0) return 'zombie';
  if (daysSinceLastOpen >= 14) return 'dormido';
  if (score >= 10 && daysSinceLastOpen < 14) return 'vip';
  return 'activo';
};

const syncTags = async () => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');

    for (const lead of rows) {
      const email = lead.email;
      const lastOpen = new Date(lead.opens);
      const now = new Date();

      const daysSinceOpen = Math.floor((now - lastOpen) / (1000 * 60 * 60 * 24));
      const degradedScore = Math.max(lead.score - daysSinceOpen, 0);
      const tag = getTagForLead(degradedScore, daysSinceOpen);

      // 🧼 Limpia otros tags
      const allTags = ['zombie', 'dormido', 'vip', 'activo'];
      const tagsToRemove = allTags.filter(t => t !== tag);

      console.log(`🔁 ${email} → ${tag} (score: ${degradedScore}, días: ${daysSinceOpen})`);

      // 🟨 Actualiza score degradado y segmento en la base de datos
      await pool.query(
        'UPDATE leads SET score = $1, segment = $2 WHERE email = $3',
        [degradedScore, tag, email]
      );

      // 🟧 Llama a Smartlead para actualizar etiquetas
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

    console.log('✅ Tags sincronizadas exitosamente con score degradado');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error al sincronizar tags:', err.message);
    process.exit(1);
  }
};

syncTags();
