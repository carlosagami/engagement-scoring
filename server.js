const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const { writeToPath } = require('fast-csv');
const fs = require('fs');
const path = require('path');

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

// Clasificación según score y días de última actividad
function determinarSegmento(score, last_open) {
  const hoy = new Date();
  const ultima = new Date(last_open);
  const diferencia = Math.floor((hoy - ultima) / (1000 * 60 * 60 * 24)); // días

  if (score >= 10 && diferencia <= 7) return 'VIP';
  if (score >= 4 && diferencia <= 15) return 'activo';
  if (score >= 2 && diferencia <= 30) return 'dormido';
  return 'zombie';
}

// Endpoint de Webhook
app.post('/webhook', async (req, res) => {
  const { email, event_type } = req.body;
  const client = await pool.connect();

  try {
    const { rows } = await client.query('SELECT * FROM leads WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(404).send('Lead no encontrado');

    const lead = rows[0];
    let score = lead.score;
    const now = new Date();

    switch (event_type) {
      case 'open':
        score += 1;
        await client.query(
          'UPDATE leads SET open_count = open_count + 1, last_open = $1, score = $2 WHERE email = $3',
          [now, score, email]
        );
        break;
      case 'click':
        score += 2;
        await client.query(
          'UPDATE leads SET click_count = click_count + 1, last_click = $1, score = $2 WHERE email = $3',
          [now, score, email]
        );
        break;
      case 'reply':
        score += 3;
        await client.query(
          'UPDATE leads SET last_reply = $1, score = $2 WHERE email = $3',
          [now, score, email]
        );
        break;
      default:
        return res.status(400).send('Evento no reconocido');
    }

    const updated = await client.query('SELECT * FROM leads WHERE email = $1', [email]);
    const nuevoSegmento = determinarSegmento(updated.rows[0].score, updated.rows[0].last_open);
    await client.query('UPDATE leads SET segment = $1 WHERE email = $2', [nuevoSegmento, email]);

    console.log(`📬 ${event_type.toUpperCase()} registrado: ${email} → ${nuevoSegmento} (score ${score})`);
    res.send(`✅ ${event_type} recibido para ${email}`);
  } catch (err) {
    console.error('❌ Error procesando webhook:', err.message);
    res.status(500).send('❌ Error interno del servidor');
  } finally {
    client.release();
  }
});

// Exportar como CSV
app.get('/export-leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads');
    const filePath = path.join(__dirname, 'leads.csv');

    const stream = fs.createWriteStream(filePath);
    writeToPath(filePath, rows, { headers: true }).pipe(stream);

    stream.on('finish', () => {
      res.download(filePath, 'leads.csv', () => fs.unlinkSync(filePath));
    });
  } catch (err) {
    console.error('❌ Error exportando leads:', err.message);
    res.status(500).send('❌ Error generando CSV');
  }
});

// Health check
app.get('/', (req, res) => res.send('✅ API funcionando correctamente'));

app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});

// Keep alive
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25000);
