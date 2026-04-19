const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getInstances, updateInstance, isManualPresence } = require('./store');
const { sendWebhook } = require('./webhook');
const { setFirstConnected, skipWarmup, recordMessageReceived, recordKnownContact } = require('./antiban');

const sessions = {};
const msgRetryCounterCache = new NodeCache();
// ADD userDevicesCache to prevent querying device lists unnecessarily (Anti-Ban)
// TTL=300s (5min) and useClones=false matches Evolution API's production config
const userDevicesCache = new NodeCache({ stdTTL: 300, useClones: false });

// ─── Anti-Loop Protection ────────────────────────────────────────────────────
// Prevents the bot from processing the same message twice or entering response loops
const processedMessages = new NodeCache({ stdTTL: 120, checkperiod: 60 }); // 2-min TTL
const chatCooldowns = new NodeCache({ stdTTL: 2, checkperiod: 5 });         // 2-sec per-chat cooldown

// ─── Reconnection Backoff ────────────────────────────────────────────────────
const retryCounters = {};  // { instanceId: retryCount }

function getBackoffDelay(instanceId) {
    const retries = retryCounters[instanceId] || 0;
    // Exponential: 5s → 10s → 20s → 40s → 80s → max 300s (5 min)
    const delay = Math.min(5000 * Math.pow(2, retries), 300000);
    // Add jitter (±20%) to avoid thundering herd
    const jitter = delay * (0.8 + Math.random() * 0.4);
    retryCounters[instanceId] = retries + 1;
    return Math.round(jitter);
}

// ─── Presence Schedule ───────────────────────────────────────────────────────
// Simulates natural online/offline patterns to avoid 24/7 bot detection
// Uses recursive setTimeout so each interval is DIFFERENT (unlike setInterval)
const presenceTimers = {};

function startPresenceSchedule(id, sock) {
    // Clear any existing timer
    stopPresenceSchedule(id);
    
    // Go available on connection
    try { sock.sendPresenceUpdate('available'); } catch (_) {}
    
    // Recursive function: each cycle gets a DIFFERENT random delay
    function scheduleNext() {
        const delay = (300 + Math.random() * 180) * 1000; // 5-8 min (random each time)
        presenceTimers[id] = setTimeout(async () => {
            try {
                const hour = new Date().getHours();
                // "Sleep" hours (midnight to 6am) → stay unavailable
                if (hour >= 0 && hour < 6) {
                    await sock.sendPresenceUpdate('unavailable');
                } else {
                    // During "awake" hours, randomly toggle to simulate breaks
                    const shouldBeOnline = Math.random() > 0.15; // 85% online
                    await sock.sendPresenceUpdate(shouldBeOnline ? 'available' : 'unavailable');
                }
            } catch (_) {}
            scheduleNext(); // Schedule next with NEW random delay
        }, delay);
    }
    scheduleNext();
}

function stopPresenceSchedule(id) {
    if (presenceTimers[id]) {
        clearTimeout(presenceTimers[id]);
        delete presenceTimers[id];
    }
}

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
        // Existing sessions are established numbers — skip warm-up
        skipWarmup(id);
        try {
            await createSession(id);
        } catch (err) {
            console.error(`[${id}] Failed to create session on startup (will retry via reconnect):`, err.message);
        }
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

    // ─── Residential Proxy Support ───────────────────────────────────────────
    // Set PROXY_URL env var in Railway to route through your home IP
    // Example: socks5://user:pass@your-home-ip:1080
    let proxyOptions = {};
    if (process.env.PROXY_URL) {
        try {
            const agent = new SocksProxyAgent(process.env.PROXY_URL);
            proxyOptions = { agent, fetchAgent: agent };
            console.log(`[${id}] Using proxy: ${process.env.PROXY_URL.replace(/\/\/.*@/, '//***@')}`);
        } catch (err) {
            console.error(`[${id}] Proxy config failed, connecting without proxy:`, err.message);
        }
    }

    const sock = makeWASocket({
        ...proxyOptions, // Spread proxy agent if configured
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        // ─── Anti-Ban & Session Stability (Enterprise-grade, Evolution API-proven) ───
        browser: ['Mac OS', 'Chrome', '133.0.0.0'], // Fingerprint as legitimate desktop Chrome
        markOnlineOnConnect: false, // Don't broadcast online status immediately to avoid spam flags
        syncFullHistory: false, // Prevent overloading the session socket on startup
        receivePendingRequests: false, // Delay heavy processing
        generateHighQualityLinkPreview: false, // False prevents Node.js HTTP leaks displaying "axios/node" as User-Agent to external URLs
        msgRetryCounterCache,
        userDevicesCache, // Essential to prevent requerying WhatsApp servers for keys every message
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000, // 30s keep-alive (Evolution API standard — less aggressive than 15s)

        // ─── Evolution API configs (battle-tested with thousands of instances) ───
        emitOwnEvents: false, // Don't re-emit our own sent messages as events (prevents self-response loops)
        retryRequestDelayMs: 350, // 350ms between failed request retries (prevents hammering WhatsApp servers)
        maxMsgRetryCount: 4, // Max 4 decrypt retries per message (prevents infinite loops on corrupt msgs)
        fireInitQueries: true, // Execute initial profile/contacts queries on connect (looks like real session)
        connectTimeoutMs: 30000, // 30s connection timeout
        qrTimeout: 45000, // 45s QR code timeout before regenerating
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 }, // Signal Protocol crypto retry config (prevents session corruption)
        shouldIgnoreJid: (jid) => {
            // Filter out newsletters and broadcasts at transport level (before our handler)
            // This reduces processing load and prevents unnecessary interactions
            const isNewsletter = jid?.endsWith('@newsletter');
            const isBroadcast = jid === 'status@broadcast';
            return isNewsletter || isBroadcast;
        },
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
            
            // Stop presence simulation
            stopPresenceSchedule(id);
            
            if (sessions[id]) {
                sessions[id].status = 'disconnected';
            }
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`[${id}] Logged out. Deleting session files...`);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                delete sessions[id];
                delete retryCounters[id]; // Clean up
            }
            
            const instances = getInstances();
            if (instances[id]) {
                const delay = getBackoffDelay(id);
                console.log(`[${id}] Reconnecting in ${Math.round(delay/1000)}s (attempt ${retryCounters[id]})...`);
                setTimeout(() => createSession(id), delay);
            } else {
                console.log(`[${id}] Instance removed from store. Stopping reconnection.`);
                delete retryCounters[id];
            }
        } else if (connection === 'open') {
            console.log(`[${id}] Connection opened!`);
            sessions[id].status = 'authenticated';
            sessions[id].qr = null;
            // Reset retry counter on successful connection
            retryCounters[id] = 0;
            // Track first connection for warm-up protocol (new numbers)
            setFirstConnected(id);
            // Start presence schedule (simulates natural online/offline)
            startPresenceSchedule(id, sock);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        // AUTO-READ: Mark incoming messages as "seen" (anti-ban: simulates real user behavior)
        // Whapi recommends: "Send read confirmation ('seen') to appear as an active, real account"
        // EXCEPTION: Manual presence instances (Candidatic Door) handle read receipts themselves
        if (!isManualPresence(id)) {
            const readKeys = messages
                .filter(m => !m.key.fromMe && m.key.remoteJid !== 'status@broadcast')
                .map(m => m.key);
            if (readKeys.length > 0) {
                try { await sock.readMessages(readKeys); } catch (_) {}
            }
        }
        
        const instances = getInstances();
        let currentReceived = instances[id]?.messages_received || 0;

        for (const msg of messages) {
            // ── Anti-Loop Protection ─────────────────────────────────────────
            // 1. Skip if we already processed this exact message ID
            const msgId = msg.key.id;
            if (processedMessages.get(msgId)) {
                continue;
            }
            processedMessages.set(msgId, true);
            
            // 2. Skip our own outgoing messages (prevent self-response loops)
            if (msg.key.fromMe) {
                continue;
            }
            
            // 3. Per-chat cooldown: if we just processed a msg from this chat <2s ago, skip
            const chatId = msg.key.remoteJid;
            if (chatCooldowns.get(chatId)) {
                // Still process for metrics but don't fire webhook (prevents rapid-fire)
                recordMessageReceived(id);
                currentReceived += 1;
                continue;
            }
            chatCooldowns.set(chatId, true);
            // ─────────────────────────────────────────────────────────────────

            currentReceived += 1;
            
            // Anti-Ban v2: Track received messages and known contacts
            recordMessageReceived(id);
            // Track this sender as a known contact (not groups, not status)
            const senderJid = msg.key.remoteJid;
            if (senderJid && !senderJid.includes('@g.us') && senderJid !== 'status@broadcast') {
                recordKnownContact(id, senderJid);
            }
            
            // UltraMsg Drop-In Replacement Adapter
            let bodyText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || "";
            let msgType = "chat";
            if (msg.message?.imageMessage) msgType = "image";
            else if (msg.message?.documentMessage) msgType = "document";
            else if (msg.message?.audioMessage) msgType = "audio";
            else if (msg.message?.videoMessage) msgType = "video";
            else if (msg.message?.stickerMessage) msgType = "sticker";
            else if (msg.message?.reactionMessage) msgType = "reaction";

            // RESOLVER PROBLEMA DE @LID (Solución Definitiva usando llave interna de Multi-Device)
            let fromCus = "";
            let author = undefined;
            const isGroup = msg.key.remoteJid && msg.key.remoteJid.includes('@g.us');

            if (isGroup) {
                fromCus = msg.key.remoteJid;
                author = msg.key.participant || msg.key.remoteJidAlt || "";
                if (author.includes('@s.whatsapp.net')) author = author.replace('@s.whatsapp.net', '@c.us');
            } else {
                const realJid = msg.key.remoteJidAlt || msg.key.participant || msg.key.remoteJid || "";
                fromCus = String(realJid);
                if (fromCus.includes('@s.whatsapp.net')) {
                    fromCus = fromCus.replace('@s.whatsapp.net', '@c.us');
                }
            }
            
            let botNumber = "";
            if (sock.user && sock.user.id) {
                botNumber = sock.user.id.split(':')[0] + '@c.us';
            }

            // AUTO-DESCARGA Y PUBLICACIÓN MULTIMEDIA CRIPTOGRÁFICA (Issue 2)
            let mediaUrl = undefined;
            let mediaData = undefined;
            if (msgType !== "chat" && msgType !== "reaction") {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { 
                        logger,
                        reuploadRequest: sock.updateMediaMessage
                    });
                    
                    if (buffer) {
                        if (msgType === "sticker") {
                            const mime = msg.message?.stickerMessage?.mimetype || 'image/webp';
                            mediaData = `data:${mime};base64,${buffer.toString('base64')}`;
                        } else {
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
                            const serverUrl = process.env.SERVER_URL || 'https://gatewaywapp-production.up.railway.app';
                            mediaUrl = `${serverUrl}/media/${fileName}`;
                        }
                    }
                } catch (err) {
                    console.error(`[${id}] Failed to decrypt or download media for ${msgType}: `, err.message);
                }
            }

            const adapterPayload = {
                id: msg.key.id,
                from: fromCus,
                to: botNumber,
                author: author, // Quien mandó el mensaje en el grupo (si es grupo)
                pushName: msg.pushName || "",
                body: bodyText,
                type: msgType,
                fromMe: msg.key.fromMe || false,
                timestamp: msg.messageTimestamp,
                contextInfo: msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo,
                __raw: msg
            };

            if (mediaUrl) {
                adapterPayload.media = mediaUrl;
            } else if (mediaData) {
                adapterPayload.media = mediaData;
            }

            if (msgType === "reaction" && msg.message?.reactionMessage) {
                adapterPayload.reaction = {
                    text: msg.message.reactionMessage.text || "",
                    stanzaId: msg.message.reactionMessage.key.id
                };
            }

            await sendWebhook(id, 'message_received', adapterPayload);
            if (global.io) {
                global.io.emit('whatsapp_message_upsert', {
                    event_type: 'message_received',
                    instanceId: id,
                    data: adapterPayload
                });
            }
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
                if (global.io) {
                    global.io.emit('whatsapp_message_update', {
                        event_type: 'message_ack',
                        instanceId: id,
                        data: ackPayload
                    });
                }
            } else {
                // Fallback for generic updates
                await sendWebhook(id, 'message_update', update);
                if (global.io) {
                    global.io.emit('whatsapp_message_update', {
                        event_type: 'message_update',
                        instanceId: id,
                        data: update
                    });
                }
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
            if (global.io) {
                global.io.emit('whatsapp_message_update', {
                    event_type: 'message_ack',
                    instanceId: id,
                    data: ackPayload
                });
            }
        }
    });

    const instanceInfo = getInstances()[id];
    if (instanceInfo) {
        sessions[id].token = instanceInfo.token;
    }
    
    return sessions[id];
};

const deleteSession = async (id) => {
    // Clean up presence schedule and retry counters to prevent memory leaks
    stopPresenceSchedule(id);
    delete retryCounters[id];
    
    if (sessions[id]) {
        if (sessions[id].sock) {
            try {
                await sessions[id].sock.logout();
            } catch (err) {
                console.log(`[${id}] Logout failed (may already be disconnected): ${err.message}`);
            }
            try {
                sessions[id].sock.end(undefined);
            } catch (err) {
                // Silent — socket may already be closed
            }
        }
        const sessionDir = path.resolve(__dirname, `../data/sessions/${id}`);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
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
