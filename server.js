// server.js

const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Segmentación
const getSegment = (score, lastOpen) => {
  const days = lastOpen ? Math.floor((Date.now() - new Date(lastOpen)) / (1000 * 60 * 60 * 24)) : 999;
  if (score >= 10 && days < 14) return 'VIP';
  if (days < 14) return 'activo';
  if (days < 30) return 'dormido';
  return 'zombie';
};

// Webhook de Smartlead
app.post('/webhook', async (req, res) => {
  const { event_type, to_email, event_timestamp } = req.body;
  const email = to_email?.toLowerCase();
  if (!email || !event_type) return res.status(400).send('Missing email or event type');

  const now = event_timestamp ? new Date(event_timestamp) : new Date();

  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE email = $1', [email]);
    const lead = rows[0];

    if (event_type === 'email_sent') {
      if (!lead) {
        await pool.query(
          'INSERT INTO leads (email, send_count, last_sent, score, segment) VALUES ($1, $2, $3, $4, $5)',
          [email, 1, now, 0, 'activo']
        );
        console.log(`📤 Nuevo lead registrado por envio: ${email}`);
      } else {
        await pool.query(
          'UPDATE leads SET send_count = send_count + 1, last_sent = $1 WHERE email = $2',
          [now, email]
        );
        console.log(`📤 Send registrado para: ${email}`);
      }
      return res.send('OK');
    }

    if (!lead) return res.status(200).send('IGNORED: unknown lead');

    let updates = {};
    let scoreDelta = 0;

    if (event_type === 'email_open') {
      updates = { open_count: 'open_count + 1', last_open: now };
      scoreDelta = 3;
    } else if (event_type === 'email_link_click') {
      updates = { click_count: 'click_count + 1', last_click: now };
      scoreDelta = 5;
    } else if (event_type === 'email_reply') {
      updates = { last_reply: now };
      scoreDelta = 10;
    } else {
      return res.status(200).send('IGNORED: unknown event');
    }

    const newScore = lead.score + scoreDelta;
    const newSegment = getSegment(newScore, event_type === 'email_open' ? now : lead.last_open);

    await pool.query(
      `UPDATE leads SET
        score = $1,
        segment = $2,
        open_count = ${updates.open_count || 'open_count'},
        click_count = ${updates.click_count || 'click_count'},
        last_open = $3,
        last_click = $4,
        last_reply = $5
        WHERE email = $6`,
      [newScore, newSegment, updates.last_open || lead.last_open, updates.last_click || lead.last_click, updates.last_reply || lead.last_reply, email]
    );

    console.log(`✅ Lead actualizado: ${email} → ${newSegment} (score ${newScore})`);
    res.send('OK');
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
    res.status(500).send('Error');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('✅ Engagement Scoring API Viva');
});

// Ver leads
app.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY score DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 API corriendo en puerto ${PORT}`);
});
