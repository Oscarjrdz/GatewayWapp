const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { getInstances, updateInstance } = require('./store');
const { sendWebhook } = require('./webhook');

const sessions = {};
const msgRetryCounterCache = new NodeCache();

const logger = pino({ level: 'silent' });

const getSessionState = (id) => {
    if (!sessions[id]) return 'disconnected';
    return sessions[id].status;
};

const getSessionQr = (id) => {
    if (!sessions[id]) return null;
    return sessions[id].qr;
};

const getSocket = (id) => {
    return sessions[id]?.sock;
};

const loadSessions = async () => {
    const instances = getInstances();
    for (const id of Object.keys(instances)) {
        await createSession(id);
    }
};

const createSession = async (id) => {
    if (sessions[id] && sessions[id].status !== 'disconnected') {
        return;
    }

    const sessionDir = path.resolve(__dirname, `../data/sessions/${id}`);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
    });

    sessions[id] = { sock, status: 'loading', qr: null, credsPath: sessionDir };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessions[id].qr = await qrcode.toDataURL(qr);
            sessions[id].status = 'qr';
            console.log(`[${id}] QR string generated`);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${id}] Connection closed. Reason: ${reason}`);
            sessions[id].status = 'disconnected';
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`[${id}] Logged out. Deleting session files...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete sessions[id];
            } else {
                console.log(`[${id}] Reconnecting...`);
                setTimeout(() => createSession(id), 5000);
            }
        } else if (connection === 'open') {
            console.log(`[${id}] Connection opened!`);
            sessions[id].status = 'authenticated';
            sessions[id].qr = null;
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            // Trigger webhook for new messages
            await sendWebhook(id, 'message_received', msg);
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            await sendWebhook(id, 'message_ack', update);
        }
    });

    const instanceInfo = getInstances()[id];
    if (instanceInfo) {
        sessions[id].token = instanceInfo.token;
    }
    
    return sessions[id];
};

const deleteSession = async (id) => {
    if (sessions[id]) {
        if (sessions[id].sock) {
            sessions[id].sock.logout();
            sessions[id].sock.end(undefined);
        }
        const sessionDir = path.resolve(__dirname, `../data/sessions/${id}`);
        fs.rmSync(sessionDir, { recursive: true, force: true });
        delete sessions[id];
    }
};

const formatJid = (number) => {
    if (!number) return '';
    number = number.toString().replace(/[^0-9]/g, '');
    if (!number.includes('@')) {
        // Decide if it's a group or private
        if (number.length > 18) {
             number = `${number}@g.us`;
        } else {
             number = `${number}@s.whatsapp.net`;
        }
    }
    return number;
};

module.exports = {
    loadSessions,
    createSession,
    deleteSession,
    getSessionState,
    getSessionQr,
    getSocket,
    formatJid
};
