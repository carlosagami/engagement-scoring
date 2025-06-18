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

app.post('/webhook', (req, res) => {
  const event = req.body;
  if (event.event === 'EMAIL_OPENED') {
    const email = event.email;
    const timestamp = event.timestamp || new Date().toISOString();
    if (!db[email]) {
      db[email] = { email, opens: [], score: 0, segment: 'nuevo' };
    }
    db[email].opens.push(timestamp);
    db[email].score += 2;
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    console.log(`✅ Registro de apertura para ${email}`);
  }
  res.status(200).send('OK');
});

app.get('/leads', (req, res) => {
  res.json(db);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook activo en puerto ${PORT}`);
});