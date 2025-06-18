const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json());

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

// 🧠 Clasificación basada en score
function clasificarLead(score) {
  if (score >= 10) return 'vip';
  if (score >= 5) return 'activo';
  if (score >= 1) return 'dormido';
  return 'zombie';
}

// 📬 Webhook principal
app.post('/webhook', async (req, res) => {
  const { event_type, to_email, event_timestamp } = req.body;
  if (!event_type || !to_email) return res.status(400).send('Faltan campos requeridos');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM leads WHERE email = $1', [to_email]);
    const now = event_timestamp || new Date().toISOString();

    if (rows.length === 0) {
      await client.query(`
        INSERT INTO leads (email, score, segment, send_count, open_count, click_count, last_sent, last_open, last_click, last_reply)
        VALUES ($1, 0, 'zombie', 0, 0, 0, NULL, NULL, NULL, NULL)
      `, [to_email]);
    }

    let scoreIncrement = 0;
    const updates = [];
    if (event_type === 'email_sent') {
      updates.push(`send_count = send_count + 1`, `last_sent = '${now}'`);
    }
    if (event_type === 'email_open') {
      updates.push(`open_count = open_count + 1`, `last_open = '${now}'`);
      scoreIncrement += 2;
    }
    if (event_type === 'email_link_click') {
      updates.push(`click_count = click_count + 1`, `last_click = '${now}'`);
      scoreIncrement += 3;
    }
    if (event_type === 'email_reply') {
      updates.push(`last_reply = '${now}'`);
      scoreIncrement += 5;
    }

    if (updates.length > 0) {
      updates.push(`score = score + ${scoreIncrement}`);
      updates.push(`segment = '${clasificarLead((rows[0]?.score || 0) + scoreIncrement)}'`);
      await client.query(`
        UPDATE leads
        SET ${updates.join(', ')}
        WHERE email = $1
      `, [to_email]);
    }

    await client.query('COMMIT');
    console.log(`📬 Evento procesado: ${event_type} → ${to_email}`);
    res.sendStatus(200);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error en webhook:', err.message);
    res.status(500).send('Error en webhook');
  } finally {
    client.release();
  }
});

// 🧾 Descargar tabla como CSV
app.get('/leads/csv', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY email ASC');
    const parser = new Parser();
    const csv = parser.parse(rows);

    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    res.send(csv);
  } catch (err) {
    console.error('❌ Error al generar CSV:', err.message);
    res.status(500).send('Error al generar CSV');
  }
});

// 🧮 Ver leads en JSON desde navegador
app.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY email ASC');
    res.json(rows);
  } catch (err) {
    console.error('❌ Error al obtener leads:', err.message);
    res.status(500).send('Error al obtener leads');
  }
});

// Iniciar servidor
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
