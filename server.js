const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const axios = require('axios');
const { Parser } = require('json2csv');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json()); // Para procesar JSON entrante

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Health check
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Webhook para aperturas desde Smartlead
app.post('/webhook', async (req, res) => {
  const email = req.body?.email?.toLowerCase?.();
  if (!email) {
    return res.status(400).send('❌ Email no proporcionado');
  }

  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    if (rows.length === 0) {
      console.log(`⚠️ Lead no encontrado: ${email}`);
      return res.status(404).send('Lead no encontrado');
    }

    const lead = rows[0];
    const updatedOpens = (lead.opens || 0) + 1;
    const updatedScore = Math.min((lead.score || 0) + 1, 5);

    let newSegment = lead.segment;
    if (updatedScore >= 4) newSegment = 'zombie';
    else if (updatedScore === 3) newSegment = 'tibio';
    else if (updatedScore <= 2) newSegment = 'frio';

    await pool.query(
      'UPDATE leads SET opens = $1, score = $2, segment = $3 WHERE email = $4',
      [updatedOpens, updatedScore, newSegment, email]
    );

    console.log(`📬 Lead actualizado: ${email} → ${newSegment} (score ${updatedScore})`);
    res.send('✅ Lead actualizado correctamente');
  } catch (err) {
    console.error('❌ Error actualizando lead:', err.message);
    res.status(500).send('Error interno');
  }
});

// Exportar leads como CSV
app.get('/leads-export', async (req, res) => {
  try {
    const result = await pool.query('SELECT email, opens, score, segment, smartlead_id FROM leads');
    const parser = new Parser();
    const csv = parser.parse(result.rows);

    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    res.send(csv);
  } catch (err) {
    console.error('❌ Error exportando CSV:', err.message);
    res.status(500).send('Error exportando leads');
  }
});

// Ping cada 25 segundos
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

// Start server
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
