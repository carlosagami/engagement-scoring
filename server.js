// server.js
const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const cors = require('cors');
const fs = require('fs');
const { Parser } = require('json2csv');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
app.use(cors());

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Health Check
app.get('/', (req, res) => {
  res.send('✅ Lead scoring API is live');
});

// Webhook de apertura
app.get('/webhook', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('❌ Email is required');

  const now = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM leads WHERE email = $1', [email]);

    if (existing.rows.length === 0) {
      await client.query(
        'INSERT INTO leads (email, opens_count, last_open, segment) VALUES ($1, $2, $3, $4)',
        [email, 1, now, 'activo']
      );
    } else {
      const { opens_count, last_open } = existing.rows[0];
      const newCount = opens_count + 1;
      let segment = 'zombie';
      const daysAgo = (d) => (now - new Date(d)) / (1000 * 60 * 60 * 24);

      if (newCount >= 10) segment = 'VIP';
      else if (daysAgo(last_open) <= 14) segment = 'activo';
      else if (daysAgo(last_open) <= 60) segment = 'dormido';

      await client.query(
        'UPDATE leads SET opens_count = $1, last_open = $2, segment = $3 WHERE email = $4',
        [newCount, now, segment, email]
      );
    }
    await client.query('COMMIT');
    res.send('✅ Webhook processed');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('❌ Error processing webhook');
  } finally {
    client.release();
  }
});

// GET /leads
app.get('/leads', async (req, res) => {
  const segment = req.query.segment;
  try {
    const query = segment
      ? 'SELECT * FROM leads WHERE segment = $1'
      : 'SELECT * FROM leads';
    const values = segment ? [segment] : [];
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Error fetching leads');
  }
});

// GET /leads/export
app.get('/leads/export', async (req, res) => {
  const segment = req.query.segment;
  try {
    const query = segment
      ? 'SELECT * FROM leads WHERE segment = $1'
      : 'SELECT * FROM leads';
    const values = segment ? [segment] : [];
    const result = await pool.query(query, values);

    const parser = new Parser();
    const csv = parser.parse(result.rows);

    res.header('Content-Type', 'text/csv');
    res.attachment('leads.csv');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Error exporting leads');
  }
});

// Init server
app.listen(port, async () => {
  console.log(`🚀 Server running on port ${port}`);
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ PostgreSQL error:', err.message);
  }
});
