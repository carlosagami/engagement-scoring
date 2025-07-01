// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
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

// Keep-alive ping
setInterval(() => {
  console.log('🌀 Keep-alive ping cada 25 segundos');
}, 25 * 1000);

app.get('/', (req, res) => {
  res.send('✅ API funcionando correctamente');
});

app.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY email');
    res.json(rows);
  } catch (err) {
    console.error('❌ Error al obtener leads:', err.message);
    res.status(500).send('Error al obtener leads');
  }
});

// ✅ Ver un lead individual
app.get('/leads/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(404).send('Lead no encontrado');
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ Error al obtener lead:', err.message);
    res.status(500).send('Error al obtener lead');
  }
});

// ✅ Webhook
app.post('/webhook', async (req, res) => {
  const data = req.body;

  // 🔍 Intentamos detectar formato plano o anidado
  const event_type = (data.event_type || data.eventType || '').toLowerCase();
  const email = data.email || data.to_email;
  const timestamp = data.timestamp || data.time_sent || data.event_timestamp || new Date().toISOString();

  if (!event_type || !email || !timestamp) {
    console.log('⚠️ Webhook ignorado por falta de datos clave:', { event_type, email, timestamp });
    return res.status(400).send('Faltan datos clave');
  }

  const now = new Date(timestamp);

  try {
    let { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    let lead = rows[0];

    if (!lead) {
      await pool.query(
        'INSERT INTO leads (email, open_count, click_count, score, segment, opens) VALUES ($1, 0, 0, 0, $2, $3)',
        [email, 'zombie', now]
      );
      lead = (await pool.query('SELECT * FROM leads WHERE email = $1', [email])).rows[0];
      console.log('🆕 Nuevo lead creado:', email);
    }

    let updates = [];
    let newScore = lead.score;
    let segment = lead.segment;

    if (event_type === 'email_open') {
      updates.push(`open_count = open_count + 1`);
      updates.push(`last_open = $2`);
      newScore += 1;
    }

    if (event_type === 'email_click') {
      updates.push(`click_count = click_count + 1`);
      updates.push(`last_click = $2`);
      newScore += 2;
    }

    if (event_type === 'email_reply') {
      updates.push(`last_reply = $2`);
      newScore += 3;
    }

    if (event_type === 'email_sent') {
      updates.push(`send_count = COALESCE(send_count, 0) + 1`);
      updates.push(`last_sent = $2`);
    }

    // Recalcular segmento
    if (newScore >= 10) segment = 'vip';
    else if (newScore >= 5) segment = 'activo';
    else if (newScore >= 2) segment = 'dormido';
    else segment = 'zombie';

    updates.push(`score = $3`);
    updates.push(`segment = $4`);

    const query = `UPDATE leads SET ${updates.join(', ')} WHERE email = $1`;
    await pool.query(query, [email, now, newScore, segment]);

    console.log(`✅ Lead actualizado: ${email} → ${segment} (score ${newScore})`);
    res.send(`✅ Lead actualizado: ${email} → ${segment}`);
  } catch (err) {
    console.error('❌ Error al procesar webhook:', err.message);
    res.status(500).send('Error interno');
  }
});

app.listen(port, async () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa a PostgreSQL');
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  }
});
