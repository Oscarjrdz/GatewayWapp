const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { initRoutes } = require('./src/routes');
const { loadSessions } = require('./src/whatsapp');
const { savePersistedContacts } = require('./src/antiban');
const { flushNow } = require('./src/store');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ensure data directories exist on startup (prevents first-write failures)
const dataDir = path.join(__dirname, 'data');
const mediaDir = path.join(dataDir, 'media');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

// Serve media static
app.use('/media', express.static(mediaDir));

// Init Routes
initRoutes(app);

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`WhatsApp API Server running on port ${PORT}`);
    console.log(`Starting saved sessions...`);
    await loadSessions();
});

// ─── Media Cleanup (every hour, delete files older than 24h) ─────────────────
// Prevents disk from filling up on Railway with accumulated media downloads
setInterval(() => {
    try {
        if (!fs.existsSync(mediaDir)) return;
        const now = Date.now();
        let cleaned = 0;
        for (const file of fs.readdirSync(mediaDir)) {
            const filePath = path.join(mediaDir, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > 86400000) { // 24 hours
                fs.unlinkSync(filePath);
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`[MediaCleanup] Deleted ${cleaned} files older than 24h`);
    } catch (err) {
        console.error('[MediaCleanup] Error:', err.message);
    }
}, 3600000); // Every hour

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
// Save antiban contact data before the process exits to prevent data loss
function gracefulShutdown(signal) {
    console.log(`\n[Server] ${signal} received. Saving data...`);
    try {
        savePersistedContacts();
        flushNow(); // Flush pending instance data writes to disk
        console.log('[Server] All data saved. Goodbye!');
    } catch (err) {
        console.error('[Server] Failed to save data:', err.message);
    }
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err.message);
    gracefulShutdown('uncaughtException');
});

