const express = require('express');
const fs = require('fs');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();
const app = express();
app.use(express.json());

const DB_PATH = path.join(__dirname, 'db.json');

// Carga o inicializa base
let db = {};
if (fs.existsSync(DB_PATH)) {
  db = JSON.parse(fs.readFileSync(DB_PATH));
} else {
  fs.writeFileSync(DB_PATH, JSON.stringify(db));
}

// 🔍 Log de cualquier petición
app.use((req, res, next) => {
  console.log('🛰️  Petición recibida:', req.method, req.originalUrl);
  console.log('📦 Body:', JSON.stringify(req.body, null, 2));
  next();
});

// Webhook principal
app.post('/webhook', (req, res) => {
  const { event, email, timestamp } = req.body;

  if (event === 'EMAIL_OPENED' && email) {
    const now = new Date();
    const openTime = timestamp || now.toISOString();

    if (!db[email]) {
      db[email] = {
        email,
        opens: [],
        score: 0,
        segment: 'nuevo'
      };
    }

    db[email].opens.push(openTime);
    db[email].score += 2;

    // Cálculo de segmentación
    const lastOpen = new Date(db[email].opens[db[email].opens.length - 1]);
    const daysSinceOpen = Math.floor((now - lastOpen) / (1000 * 60 * 60 * 24));

    if (daysSinceOpen >= 30 || db[email].score <= 0) {
      db[email].segment = 'zombie';
    } else if (daysSinceOpen >= 14) {
      db[email].segment = 'dormido';
    } else if (db[email].score >= 10) {
      db[email].segment = 'VIP';
    } else {
      db[email].segment = 'activo';
    }

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    console.log(`✅ Registro guardado para ${email} (${db[email].segment})`);
  } else {
    console.log('⚠️ Webhook recibido sin email o evento válido');
  }

  res.status(200).send('OK');
});

// Ver leads
app.get('/leads', (req, res) => {
  res.json(db);
});

// 🔥 IMPORTANTE: usar solo el puerto que Railway define
const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
