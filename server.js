const express = require('express');
const cors = require('cors');
const { initRoutes } = require('./src/routes');
const { loadSessions } = require('./src/whatsapp');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Init Routes
initRoutes(app);

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`WhatsApp API Server running on port ${PORT}`);
    console.log(`Starting saved sessions...`);
    await loadSessions();
});
