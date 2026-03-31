const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { getInstances, updateInstance } = require('./store');
const { sendWebhook } = require('./webhook');

const sessions = {};
const msgRetryCounterCache = new NodeCache();
// ADD userDevicesCache to prevent querying device lists unnecessarily (Anti-Ban)
const userDevicesCache = new NodeCache();

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
        // Anti-ban & Session Stability configs (Enterprise-grade)
        browser: ['Mac OS', 'Chrome', '125.0.0.0'], // Fingerprint as legitimate desktop Chrome
        markOnlineOnConnect: false, // Don't broadcast online status immediately to avoid spam flags
        syncFullHistory: false, // Prevent overloading the session socket on startup
        receivePendingRequests: false, // Delay heavy processing
        generateHighQualityLinkPreview: false, // False prevents Node.js HTTP leaks displaying "axios/node" as User-Agent to external URLs
        msgRetryCounterCache,
        userDevicesCache, // Essential to prevent requerying WhatsApp servers for keys every message
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 15000, // Send keep-alives to prevent WebSocket termination by ISP/WhatsApp
        getMessage: async (key) => {
            // Needed to prevent crashing on quoted messages WhatsApp forces us to decrypt
            return { conversation: '' };
        }
    });

    // Automatically reject incoming voice/video calls to prevent session instability or flags
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                try {
                    await sock.rejectCall(call.id, call.from);
                    console.log(`[${id}] Auto-rejected call from ${call.from} to protect session.`);
                } catch (err) {
                    console.log(`[${id}] Failed to reject call:`, err);
                }
            }
        }
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
            
            if (sessions[id]) {
                sessions[id].status = 'disconnected';
            }
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`[${id}] Logged out. Deleting session files...`);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                delete sessions[id];
            }
            
            const instances = getInstances();
            if (instances[id]) {
                console.log(`[${id}] Reconnecting (or generating new QR)...`);
                setTimeout(() => createSession(id), 5000);
            } else {
                console.log(`[${id}] Instance removed from store. Stopping reconnection.`);
            }
        } else if (connection === 'open') {
            console.log(`[${id}] Connection opened!`);
            sessions[id].status = 'authenticated';
            sessions[id].qr = null;
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const instances = getInstances();
        let currentReceived = instances[id]?.messages_received || 0;

        for (const msg of messages) {
            // PREVENT CRASH/BANS: Ignore incoming broadcasted statuses from other people.
            // Downloading hundreds of candidates' video/picture statuses will stall the WebSocket and trigger bans
            if (msg.key?.remoteJid === 'status@broadcast' && !msg.key?.fromMe) {
                continue;
            }

            currentReceived += 1;
            
            // UltraMsg Drop-In Replacement Adapter
            let bodyText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || "";
            let msgType = "chat";
            if (msg.message?.imageMessage) msgType = "image";
            else if (msg.message?.documentMessage) msgType = "document";
            else if (msg.message?.audioMessage) msgType = "audio";
            else if (msg.message?.videoMessage) msgType = "video";
            else if (msg.message?.stickerMessage) msgType = "sticker";

            // RESOLVER PROBLEMA DE @LID (Solución Definitiva usando llave interna de Multi-Device)
            const realJid = msg.key.remoteJidAlt || msg.key.participant || msg.key.remoteJid || "";
            let fromCus = String(realJid);
            if (fromCus.includes('@s.whatsapp.net')) {
                fromCus = fromCus.replace('@s.whatsapp.net', '@c.us');
            }
            
            let botNumber = "";
            if (sock.user && sock.user.id) {
                botNumber = sock.user.id.split(':')[0] + '@c.us';
            }

            // AUTO-DESCARGA Y PUBLICACIÓN MULTIMEDIA CRIPTOGRÁFICA (Issue 2)
            let mediaUrl = undefined;
            if (msgType !== "chat" && msgType !== "sticker") {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { 
                        logger,
                        reuploadRequest: sock.updateMediaMessage
                    });
                    
                    if (buffer) {
                        const crypto = require('crypto');
                        const mediaDir = path.resolve(__dirname, '../data/media');
                        if (!fs.existsSync(mediaDir)) {
                            fs.mkdirSync(mediaDir, { recursive: true });
                        }
                        
                        let ext = "bin";
                        const mime = msg.message[`${msgType}Message`]?.mimetype || "";
                        if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
                        else if (mime.includes('png')) ext = 'png';
                        else if (mime.includes('pdf')) ext = 'pdf';
                        else if (mime.includes('mp4')) ext = 'mp4';
                        else if (mime.includes('ogg')) ext = 'ogg';

                        const fileName = `${crypto.randomUUID()}.${ext}`;
                        fs.writeFileSync(path.join(mediaDir, fileName), buffer);
                        
                        // URL pública inyectada
                        const serverUrl = 'https://gatewaywapp-production.up.railway.app';
                        mediaUrl = `${serverUrl}/media/${fileName}`;
                    }
                } catch (err) {
                    console.error(`[${id}] Failed to decrypt or download media: `, err.message);
                }
            }

            const adapterPayload = {
                id: msg.key.id,
                from: fromCus,
                to: botNumber,
                pushName: msg.pushName || "",
                body: bodyText,
                type: msgType,
                fromMe: msg.key.fromMe || false,
                timestamp: msg.messageTimestamp,
                __raw: msg
            };

            if (mediaUrl) {
                adapterPayload.media = mediaUrl;
            }

            await sendWebhook(id, 'message_received', adapterPayload);
        }
        
        updateInstance(id, { messages_received: currentReceived });
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            // Check if it's a status notification (delivery/read)
            if (update.update && update.update.status) {
                const statusMap = {
                    2: "sent",
                    3: "delivered",
                    4: "read"
                };
                const stringStatus = statusMap[update.update.status] || "unknown";
                
                let botNumber = "";
                if (sock.user && sock.user.id) {
                    botNumber = sock.user.id.split(':')[0] + '@c.us';
                }
                
                const ackPayload = {
                    id: update.key.id,
                    status: stringStatus,
                    to: botNumber,
                    __raw: update
                };
                await sendWebhook(id, 'message_ack', ackPayload);
            } else {
                // Fallback for generic updates
                await sendWebhook(id, 'message_update', update);
            }
        }
    });

    // Catch Story views (read receipts on status@broadcast usually come directly here)
    sock.ev.on('message-receipt.update', async (updates) => {
        for (const update of updates) {
            let botNumber = "";
            if (sock.user && sock.user.id) {
                botNumber = sock.user.id.split(':')[0] + '@c.us';
            }
            
            // Format raw to match the client's expected nested key->participant object
            const rawFormatted = {
                key: {
                    id: update.key?.id || '',
                    remoteJid: update.key?.remoteJid || '',
                    participant: update.receipt?.userJid || update.key?.participant || ''
                },
                receipt: update.receipt
            };
            
            const ackPayload = {
                id: update.key?.id || '',
                status: "read",
                to: botNumber,
                __raw: rawFormatted
            };
            
            console.log(`[${id}] WEBHOOK POST message_ack (View) for ID: ${rawFormatted.key.id} from: ${rawFormatted.key.participant}`);
            await sendWebhook(id, 'message_ack', ackPayload);
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
    let numStr = number.toString();
    if (numStr.includes('@c.us')) numStr = numStr.replace('@c.us', '@s.whatsapp.net');
    
    let parts = numStr.split('@');
    let bare = parts[0].replace(/[^0-9]/g, '');
    let domain = parts[1] || (bare.length > 18 ? 'g.us' : 's.whatsapp.net');
    return `${bare}@${domain}`;
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
