const axios = require('axios');

const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
const BASE_URL = 'https://server.smartlead.ai/api/v1';

async function testSmartleadApiKey() {
  try {
    console.log('🔐 Probando API Key:', SMARTLEAD_API_KEY);

    const res = await axios.get(`${BASE_URL}/leads`, {
      headers: {
        Authorization: `Bearer ${SMARTLEAD_API_KEY}`
      }
    });

    console.log('✅ ¡Éxito! Leads obtenidos:', res.data.length);
  } catch (error) {
    console.error('❌ Error al probar Smartlead API:', error.response?.status, error.response?.data || error.message);
  }
}

testSmartleadApiKey();
