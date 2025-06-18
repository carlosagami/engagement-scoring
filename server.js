const express = require('express');
const fs = require('fs');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();
const app = express();
app.use(express.json());

const DB_PATH = path.join(__dirname, 'db.json');
let db = {};
if (fs.existsSync(DB_PATH)) {
  db = JSON.parse(fs.readFileSync(DB_PATH));
} else {
  fs.writeFileSync(DB_PATH, JSON.stringify(db));
}

// 🔍 LOG DE CUALQUIER COSA QUE LLEGUE
app.use((req, res, next) => {
  console.log('🛰️  Petición recibida:', req.method, req.originalUrl);
  console.log('📦 Body:', JSON.stringify(req.body, null, 2));
  next();
});

app.post('/webhook', (req, res) => {
  const { event, email, timestamp } = req.body;

  if (event === 'EMAIL_OPENED' && email) {
    if (!db[email]) {
      db[email] = { email, opens: [], score: 0, segment: 'nuevo' };
    }
    db[email].opens.push(timestamp || new Date().toISOString());
    db[email].score += 2;

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    console.log(`✅ Registro de apertura para ${email}`);
  } else {
    console.log('⚠️ Webhook recibido, pero sin email o evento válido');
  }

  res.status(200).send('OK');
});

app.get('/leads', (req, res) => {
  res.json(db);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
