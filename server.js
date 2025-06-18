const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
app.use(express.json());

// Conexión a PostgreSQL
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Verifica conexión al arrancar
pool.connect()
  .then(() => console.log('✅ Conexión exitosa a PostgreSQL'))
  .catch(err => {
    console.error('❌ Error de conexión a PostgreSQL:', err.message);
    process.exit(1);
  });

// Webhook principal
app.post('/webhook', async (req, res) => {
  const { event, email, timestamp } = req.body;

  if (event !== 'EMAIL_OPENED' || !email) {
    console.log('⚠️ Webhook ignorado');
    return res.status(200).send('IGNORED');
  }

  const openDate = timestamp ? new Date(timestamp) : new Date();

  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    let lead = rows[0];
    let score = 2;
    let segment = 'activo';

    if (lead) {
      score = lead.score + 2;

      const lastOpen = new Date(lead.opens);
      const days = Math.floor((new Date() - lastOpen) / (1000 * 60 * 60 * 24));

      if (days >= 30 || score <= 0) segment = 'zombie';
      else if (days >= 14) segment = 'dormido';
      else if (score >= 10) segment = 'VIP';
    }

    await pool.query(
      `INSERT INTO leads (email, opens, score, segment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email)
       DO UPDATE SET opens = $2, score = $3, segment = $4`,
      [email, openDate, score, segment]
    );

    console.log(`✅ Lead actualizado: ${email} → ${segment}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Error al guardar lead:', err.message);
    res.status(500).send('ERROR');
  }
});

// Consulta directa
app.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liveness check
app.get('/', (req, res) => {
  res.send('✅ Engagement Scoring API Viva');
});

// 🔁 Mantener Railway activo
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25000);

// Arranque de servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API corriendo en puerto ${PORT}`);
});
