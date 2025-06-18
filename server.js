const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { Parser } = require('json2csv');

dotenv.config();

const app = express();
app.use(express.json());

const port = process.env.PORT || 8080;

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Lógica de segmentación
function getSegment(score, daysSinceLastOpen) {
  if (score >= 10 && daysSinceLastOpen <= 7) return 'VIP';
  if (score >= 3 && daysSinceLastOpen <= 14) return 'activo';
  if (score >= 1 && daysSinceLastOpen <= 30) return 'dormido';
  return 'zombie';
}

// Ping keep-alive
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

// Salud
app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

// Webhook de eventos Smartlead
app.post('/webhook', async (req, res) => {
  const payload = req.body;

  try {
    const email = payload?.lead?.email;
    const eventType = payload?.event;

    if (!email || !eventType) {
      console.warn('❌ Webhook malformado:', req.body);
      return res.status(400).send('Payload incompleto');
    }

    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM leads WHERE email = $1', [email]);
      if (result.rows.length === 0) {
        console.warn('❌ Lead no encontrado en BD:', email);
        return res.status(404).send('Lead no encontrado');
      }

      const lead = result.rows[0];
      let updates = {};
      const today = new Date().toISOString().split('T')[0];

      switch (eventType) {
        case 'email_sent':
          updates.send_count = (lead.send_count || 0) + 1;
          updates.last_sent = today;
          break;
        case 'email_open':
          updates.open_count = (lead.open_count || 0) + 1;
          updates.last_open = today;
          updates.score = (lead.score || 0) + 1;
          break;
        case 'email_link_click':
          updates.click_count = (lead.click_count || 0) + 1;
          updates.last_click = today;
          updates.score = (lead.score || 0) + 2;
          break;
        case 'email_reply':
          updates.last_reply = today;
          updates.score = (lead.score || 0) + 3;
          break;
        default:
          console.warn('⚠️ Evento no manejado:', eventType);
          return res.status(400).send('Evento no reconocido');
      }

      const lastOpenDate = new Date(updates.last_open || lead.last_open || lead.opens || today);
      const daysSinceOpen = Math.floor((Date.now() - new Date(lastOpenDate)) / (1000 * 60 * 60 * 24));
      updates.segment = getSegment(updates.score || lead.score || 0, daysSinceOpen);

      const fields = Object.keys(updates);
      const values = Object.values(updates);
      const setters = fields.map((field, i) => `${field} = $${i + 1}`).join(', ');

      await client.query(
        `UPDATE leads SET ${setters} WHERE email = $${fields.length + 1}`,
        [...values, email]
      );

      console.log(`📬 Lead actualizado: ${email} → ${updates.segment} (score ${updates.score || lead.score})`);
      res.send('✅ Evento procesado');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Error en webhook:', err);
    res.status(500).send('Error interno');
  }
});

// Endpoint de exportación CSV
app.get('/export-csv', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads');
    const parser = new Parser();
    const csv = parser.parse(result.rows);
    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    res.send(csv);
  } catch (err) {
    console.error('❌ Error exportando CSV:', err);
    res.status(500).send('Error exportando CSV');
  }
});

// Arranque
app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
