const express = require('express');
const { getInstances, updateInstance, deleteInstance, defaultSettings } = require('./store');
const { createSession, getSessionState, getSessionQr, getSocket, deleteSession } = require('./whatsapp');
const { v4: uuidv4 } = require('uuid');

const requireAuth = (req, res, next) => {
    let instanceId = req.params.instanceId;
    // support both /instance123/ and /123/
    if (instanceId.startsWith('instance')) {
        instanceId = instanceId.replace('instance', '');
    }
    
    // Check token in body or query
    const token = req.body?.token || req.query?.token;
    if (!token) return res.status(401).json({ error: 'Token is required' });
    
    const instances = getInstances();
    const instance = instances[instanceId];
    
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.token !== token) return res.status(403).json({ error: 'Invalid token' });
    
    req.instanceId = instanceId;
    req.instance = instance;
    next();
};

const formatJid = (number) => {
    if (!number) return '';
    number = number.toString().replace(/[^0-9]/g, '');
    if (!number.includes('@')) {
        if (number.length > 18) {
             number = `${number}@g.us`;
        } else {
             number = `${number}@s.whatsapp.net`;
        }
    }
    return number;
};

const initRoutes = (app) => {
    // Generate new instance
    app.post('/instances', async (req, res) => {
        const id = uuidv4().replace(/-/g, '').substring(0, 10);
        const token = uuidv4().replace(/-/g, '');
        
        updateInstance(id, { ...defaultSettings, token });
        await createSession(id);
        
        res.json({ instance_id: `instance${id}`, token });
    });

    // List all instances (Personal Dashboard Only)
    app.get('/instances', (req, res) => {
        const instances = getInstances();
        const list = Object.keys(instances).map(id => ({
            instance_id: `instance${id}`,
            token: instances[id].token,
            status: getSessionState(id),
            webhook_url: instances[id].webhook_url || '',
            webhook_message_received: instances[id].webhook_message_received || false,
            messages_sent: instances[id].messages_sent || 0,
            messages_received: instances[id].messages_received || 0
        }));
        res.json(list);
    });

    // Get Status
    app.get('/:instanceId/status', requireAuth, async (req, res) => {
        const status = getSessionState(req.instanceId);
        res.json({ 
            instanceId: req.instanceId, 
            status,
            webhook_url: req.instance.webhook_url,
            webhook_message_received: req.instance.webhook_message_received,
            messages_sent: req.instance.messages_sent || 0,
            messages_received: req.instance.messages_received || 0
        });
    });

    // Get QR
    app.get('/:instanceId/qr', requireAuth, async (req, res) => {
        const qr = getSessionQr(req.instanceId);
        res.json({ instanceId: req.instanceId, qr });
    });

    // Logout
    app.post('/:instanceId/logout', requireAuth, async (req, res) => {
        await deleteSession(req.instanceId);
        deleteInstance(req.instanceId);
        res.json({ success: true, message: 'Instance deleted' });
    });

    // Send Text Message
    app.post('/:instanceId/messages/chat', requireAuth, async (req, res) => {
        const { to, body } = req.body;
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let jid = formatJid(to);
            
            // Auto-resolve JID against WhatsApp database to fix Mexico 52 vs 521 or invalid numbers
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) {
                    jid = result.jid;
                } else {
                    return res.status(400).json({ error: 'El número no existe en WhatsApp' });
                }
            }

            const msg = await sock.sendMessage(jid, { text: body || '' });
            
            // Increment Sent
            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });
            
            res.json({ messageId: msg.key.id, status: 'sent', id: msg.key.id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send Image Message
    app.post('/:instanceId/messages/image', requireAuth, async (req, res) => {
        const { to, image, caption } = req.body;
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let jid = formatJid(to);
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) jid = result.jid;
                else return res.status(400).json({ error: 'El número no existe en WhatsApp' });
            }

            let mediaTypeOptions = {};
            if (image.startsWith('http')) {
                mediaTypeOptions = { url: image };
            } else {
                mediaTypeOptions = Buffer.from(image, 'base64');
            }

            const msg = await sock.sendMessage(jid, { image: mediaTypeOptions, caption: caption || '' });
            res.json({ messageId: msg.key.id, status: 'sent', id: msg.key.id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send Document Message
    app.post('/:instanceId/messages/document', requireAuth, async (req, res) => {
        const { to, document, filename } = req.body;
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let jid = formatJid(to);
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) jid = result.jid;
                else return res.status(400).json({ error: 'El número no existe en WhatsApp' });
            }

            let mediaTypeOptions = {};
            if (document.startsWith('http')) {
                mediaTypeOptions = { url: document };
            } else {
                mediaTypeOptions = Buffer.from(document, 'base64');
            }

            const msg = await sock.sendMessage(jid, { 
                document: mediaTypeOptions, 
                fileName: filename || 'document',
                mimetype: 'application/octet-stream' 
            });
            res.json({ messageId: msg.key.id, status: 'sent', id: msg.key.id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send Audio / Voice Note Message
    app.post('/:instanceId/messages/audio', requireAuth, async (req, res) => {
        const { to, audio, ptt } = req.body;
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let jid = formatJid(to);
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) jid = result.jid;
                else return res.status(400).json({ error: 'El número no existe en WhatsApp' });
            }

            let mediaTypeOptions = {};
            if (audio.startsWith('http')) {
                mediaTypeOptions = { url: audio };
            } else {
                mediaTypeOptions = Buffer.from(audio, 'base64');
            }

            const msg = await sock.sendMessage(jid, { 
                audio: mediaTypeOptions, 
                mimetype: 'audio/mp4',
                ptt: ptt === true || ptt === 'true' // if true, it renders as a voice note
            });
            res.json({ messageId: msg.key.id, status: 'sent', id: msg.key.id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send Presence (Typing, Recording, Online)
    app.post('/:instanceId/presence', requireAuth, async (req, res) => {
        const { to, status } = req.body;
        // status options: 'available', 'unavailable', 'composing', 'recording', 'paused'
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let jid = formatJid(to);
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) jid = result.jid;
                else return res.status(400).json({ error: 'El número no existe en WhatsApp' });
            }

            await sock.sendPresenceUpdate(status || 'composing', jid);
            res.json({ success: true, status: status || 'composing', jid });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    
    // Get WhatsApp Profile Picture
    app.get('/:instanceId/contacts/profile-picture', requireAuth, async (req, res) => {
        const { to } = req.query;
        if (!to) return res.status(400).json({ error: 'Phone number (to) is required' });

        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let jid = formatJid(to);
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) jid = result.jid;
                else return res.status(400).json({ error: 'El número no existe en WhatsApp' });
            }

            // profilePictureUrl fetches the high-res link if possible
            const ppUrl = await sock.profilePictureUrl(jid, 'image'); 
            res.json({ jid, profile_picture: ppUrl });
        } catch (err) {
            // usually throws if user has privacy settings preventing access or no picture
            console.error(err);
            res.status(404).json({ error: 'No profile picture found or privacy settings prevent access' });
        }
    });

    // Settings Webhook
    app.post('/:instanceId/settings/webhook', requireAuth, (req, res) => {
        const { webhook_url, webhook_message_received, webhook_message_ack } = req.body;
        
        updateInstance(req.instanceId, { 
            webhook_url: webhook_url || req.instance.webhook_url,
            webhook_message_received: webhook_message_received !== undefined ? (webhook_message_received === 'true' || webhook_message_received === true) : req.instance.webhook_message_received,
            webhook_message_ack: webhook_message_ack !== undefined ? (webhook_message_ack === 'true' || webhook_message_ack === true) : req.instance.webhook_message_ack,
        });
        
        res.json({ success: true, message: 'Settings saved' });
    });
};

module.exports = { initRoutes };
