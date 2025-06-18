const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { parseAsync } = require('json2csv');

dotenv.config();
const app = express();
const port = process.env.PORT || 8080;
app.use(express.json());

// PostgreSQL pool
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false },
});

// Clasificación de segmentos por score
function getSegment(score) {
  if (score >= 10) return 'vip';
  if (score >= 4) return 'activo';
  if (score >= 2) return 'dormido';
  return 'zombie';
}

// Health check
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Keep-alive
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

// Webhook de eventos de Smartlead
app.post('/webhook', async (req, res) => {
  const event = req.body?.event;
  const email = req.body?.lead?.email?.toLowerCase();
  const now = new Date();

  if (!event || !email) return res.status(400).send('Faltan datos');

  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    let lead = rows[0];

    if (!lead) {
      await pool.query(
        `INSERT INTO leads (email, score, segment, open_count, click_count)
         VALUES ($1, 0, 'zombie', 0, 0)`,
        [email]
      );
      lead = { email, score: 0, segment: 'zombie', open_count: 0, click_count: 0 };
      console.log('🆕 Nuevo lead creado:', email);
    }

    let updates = {};
    let newScore = lead.score;

    if (event === 'email_sent') {
      updates.last_sent = now;
      updates.send_count = (lead.send_count || 0) + 1;
    }

    if (event === 'email_open') {
      updates.last_open = now;
      updates.open_count = (lead.open_count || 0) + 1;
      newScore += 1;
    }

    if (event === 'email_link_click') {
      updates.last_click = now;
      updates.click_count = (lead.click_count || 0) + 1;
      newScore += 2;
    }

    if (event === 'email_reply') {
      updates.last_reply = now;
      newScore += 3;
    }

    updates.score = newScore;
    updates.segment = getSegment(newScore);

    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setters = fields.map((f, i) => `${f} = $${i + 1}`);

    await pool.query(
      `UPDATE leads SET ${setters.join(', ')} WHERE email = $${fields.length + 1}`,
      [...values, email]
    );

    console.log(`📬 Evento procesado: ${event} → ${email}`);
    res.send('✅ Webhook recibido');
  } catch (err) {
    console.error('❌ Error al procesar webhook:', err.message);
    res.status(500).send('Error procesando webhook');
  }
});

// Ver todos los leads
app.get('/leads', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY score DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error obteniendo leads:', err.message);
    res.status(500).send('Error obteniendo leads');
  }
});

// Exportar leads como CSV
app.get('/export-csv', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY score DESC');
    const csv = await parseAsync(result.rows);
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('❌ Error exportando CSV:', err.message);
    res.status(500).send('Error exportando CSV');
  }
});

// Inicia el servidor
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
