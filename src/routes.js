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
    let numStr = number.toString();
    if (numStr.includes('@c.us')) numStr = numStr.replace('@c.us', '@s.whatsapp.net');
    
    let parts = numStr.split('@');
    let bare = parts[0].replace(/[^0-9]/g, '');
    let domain = parts[1] || (bare.length > 18 ? 'g.us' : 's.whatsapp.net');
    return `${bare}@${domain}`;
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
            messages_received: instances[id].messages_received || 0,
            instance_name: instances[id].instance_name || ''
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
            messages_received: req.instance.messages_received || 0,
            instance_name: req.instance.instance_name || ''
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
            
            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });
            
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
            
            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });
            
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
            
            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });
            
            res.json({ messageId: msg.key.id, status: 'sent', id: msg.key.id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send Sticker Message
    app.post('/:instanceId/messages/sticker', requireAuth, async (req, res) => {
        const { to, sticker } = req.body;
        
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
            if (sticker.startsWith('http')) {
                mediaTypeOptions = { url: sticker };
            } else {
                mediaTypeOptions = Buffer.from(sticker, 'base64');
            }

            const msg = await sock.sendMessage(jid, { 
                sticker: mediaTypeOptions
            });
            
            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });
            
            res.json({ messageId: msg.key.id, status: 'sent', id: msg.key.id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send Location Message
    app.post('/:instanceId/messages/location', requireAuth, async (req, res) => {
        const { to, lat, lng, name, address } = req.body;
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        if (lat === undefined || lng === undefined) {
            return res.status(400).json({ error: 'lat and lng are required' });
        }

        try {
            let jid = formatJid(to);
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) jid = result.jid;
                else return res.status(400).json({ error: 'El número no existe en WhatsApp' });
            }

            const msg = await sock.sendMessage(jid, { 
                location: { 
                    degreesLatitude: lat, 
                    degreesLongitude: lng,
                    name: name || undefined,
                    address: address || undefined
                }
            });
            
            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });
            
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

    // Publish WhatsApp Status (Story)
    app.post('/:instanceId/stories', requireAuth, async (req, res) => {
        const { type, text, image, video, caption, color, font, contacts } = req.body;
        // type: 'text', 'image', 'video'
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let mediaTypeOptions = null;
            
            if (type === 'text' && text) {
                mediaTypeOptions = { 
                    text: text, 
                    backgroundColor: color || '#FF5733', 
                    font: font || 1 
                };
            } else if (type === 'image' && image) {
                const buf = image.startsWith('http') ? { url: image } : Buffer.from(image, 'base64');
                mediaTypeOptions = { image: buf, caption: caption || '' };
            } else if (type === 'video' && video) {
                const buf = video.startsWith('http') ? { url: video } : Buffer.from(video, 'base64');
                mediaTypeOptions = { video: buf, caption: caption || '' };
            } else {
                return res.status(400).json({ error: "Missing required payload: text, image or video depending on the 'type'." });
            }

            const jidList = (contacts || []).map(formatJid);

            const msg = await sock.sendMessage('status@broadcast', mediaTypeOptions, {
                statusJidList: jidList.length > 0 ? jidList : undefined
            });
            
            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });
            
            res.json({ success: true, status: 'published', id: msg?.key?.id, type });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ─── WhatsApp Channels (Newsletters) ────────────────────────────────────────

    // Create a new WhatsApp Channel
    app.post('/:instanceId/channels', requireAuth, async (req, res) => {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });

        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            const channel = await sock.newsletterCreate(name, description || '');
            res.json({ success: true, channel });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get Channel Metadata (by JID or invite link)
    app.get('/:instanceId/channels/:channelId', requireAuth, async (req, res) => {
        const { channelId } = req.params;
        // channelId can be a full JID (xxx@newsletter) or an invite code
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            const type = channelId.includes('@newsletter') ? 'jid' : 'invite';
            const metadata = await sock.newsletterMetadata(type, channelId);
            if (!metadata) return res.status(404).json({ error: 'Channel not found' });
            res.json(metadata);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get Channel Subscribers
    app.get('/:instanceId/channels/:channelId/subscribers', requireAuth, async (req, res) => {
        const { channelId } = req.params;
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            const result = await sock.newsletterSubscribers(channelId);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Update Channel (name, description, or picture)
    app.patch('/:instanceId/channels/:channelId', requireAuth, async (req, res) => {
        const { channelId } = req.params;
        const { name, description, picture } = req.body;
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            if (name) await sock.newsletterUpdateName(channelId, name);
            if (description) await sock.newsletterUpdateDescription(channelId, description);
            if (picture) {
                const buf = picture.startsWith('http') ? { url: picture } : Buffer.from(picture, 'base64');
                await sock.newsletterUpdatePicture(channelId, buf);
            }
            res.json({ success: true, message: 'Channel updated' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send a Message to a Channel
    app.post('/:instanceId/channels/:channelId/messages', requireAuth, async (req, res) => {
        const { channelId } = req.params;
        const { type, text, image, video, caption } = req.body;
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });

        try {
            let content = null;
            if (type === 'text' || (!type && text)) {
                content = { text: text || '' };
            } else if (type === 'image' && image) {
                const buf = image.startsWith('http') ? { url: image } : Buffer.from(image, 'base64');
                content = { image: buf, caption: caption || '' };
            } else if (type === 'video' && video) {
                const buf = video.startsWith('http') ? { url: video } : Buffer.from(video, 'base64');
                content = { video: buf, caption: caption || '' };
            } else {
                return res.status(400).json({ error: "Missing required content: text, image, or video." });
            }

            const jid = channelId.includes('@newsletter') ? channelId : `${channelId}@newsletter`;
            const msg = await sock.sendMessage(jid, content);

            const currentSent = req.instance.messages_sent || 0;
            updateInstance(req.instanceId, { messages_sent: currentSent + 1 });

            res.json({ success: true, id: msg?.key?.id, status: 'sent' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Follow a Channel
    app.post('/:instanceId/channels/:channelId/follow', requireAuth, async (req, res) => {
        const { channelId } = req.params;
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            await sock.newsletterFollow(channelId);
            res.json({ success: true, message: 'Channel followed' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Unfollow a Channel
    app.post('/:instanceId/channels/:channelId/unfollow', requireAuth, async (req, res) => {
        const { channelId } = req.params;
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            await sock.newsletterUnfollow(channelId);
            res.json({ success: true, message: 'Channel unfollowed' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete a Channel (only owner)
    app.delete('/:instanceId/channels/:channelId', requireAuth, async (req, res) => {
        const { channelId } = req.params;
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            await sock.newsletterDelete(channelId);
            res.json({ success: true, message: 'Channel deleted' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ────────────────────────────────────────────────────────────────────────────

    // ─── WhatsApp Groups ─────────────────────────────────────────────────────────

    // Create a new Group
    app.post('/:instanceId/groups', requireAuth, async (req, res) => {
        const { name, participants } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!participants || !Array.isArray(participants) || participants.length === 0)
            return res.status(400).json({ error: 'participants[] with at least 1 member is required' });
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            const group = await sock.groupCreate(name, participants.map(formatJid));
            res.json({ success: true, group });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Get All Groups (where this number participates)
    app.get('/:instanceId/groups', requireAuth, async (req, res) => {
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            const groups = await sock.groupFetchAllParticipating();
            res.json(groups);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Get Group Metadata
    app.get('/:instanceId/groups/:groupId', requireAuth, async (req, res) => {
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            const metadata = await sock.groupMetadata(formatJid(req.params.groupId));
            res.json(metadata);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Manage Participants (add / remove / promote / demote)
    app.post('/:instanceId/groups/:groupId/participants', requireAuth, async (req, res) => {
        const { action, participants } = req.body;
        if (!action || !participants || !Array.isArray(participants))
            return res.status(400).json({ error: 'action and participants[] are required' });
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            const result = await sock.groupParticipantsUpdate(formatJid(req.params.groupId), participants.map(formatJid), action);
            res.json({ success: true, result });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Update Group (name / description / picture)
    app.patch('/:instanceId/groups/:groupId', requireAuth, async (req, res) => {
        const { name, description, picture } = req.body;
        const jid = formatJid(req.params.groupId);
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            if (name) await sock.groupUpdateSubject(jid, name);
            if (description !== undefined) await sock.groupUpdateDescription(jid, description);
            if (picture) {
                const buf = picture.startsWith('http') ? { url: picture } : Buffer.from(picture, 'base64');
                await sock.updateProfilePicture(jid, buf);
            }
            res.json({ success: true, message: 'Group updated' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Get Group Invite Link
    app.get('/:instanceId/groups/:groupId/invite', requireAuth, async (req, res) => {
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            const code = await sock.groupInviteCode(formatJid(req.params.groupId));
            res.json({ invite_link: `https://chat.whatsapp.com/${code}`, code });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Revoke Group Invite Link
    app.post('/:instanceId/groups/:groupId/invite/revoke', requireAuth, async (req, res) => {
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            const code = await sock.groupRevokeInvite(formatJid(req.params.groupId));
            res.json({ success: true, new_invite_link: `https://chat.whatsapp.com/${code}` });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Join Group by Invite Code
    app.post('/:instanceId/groups/join', requireAuth, async (req, res) => {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'code is required' });
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            const groupJid = await sock.groupAcceptInvite(code);
            res.json({ success: true, group_jid: groupJid });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Leave Group
    app.post('/:instanceId/groups/:groupId/leave', requireAuth, async (req, res) => {
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            await sock.groupLeave(formatJid(req.params.groupId));
            res.json({ success: true, message: 'Left the group' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Update Group Settings (announcements / lock)
    app.post('/:instanceId/groups/:groupId/settings', requireAuth, async (req, res) => {
        const { setting } = req.body;
        // setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'
        if (!setting) return res.status(400).json({ error: 'setting is required' });
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        try {
            await sock.groupSettingUpdate(formatJid(req.params.groupId), setting);
            res.json({ success: true, setting });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ────────────────────────────────────────────────────────────────────────────

    // Mark Messages as Read (Blue Ticks)

    app.post('/:instanceId/messages/read', requireAuth, async (req, res) => {
        const { messageId, to } = req.body;
        
        const sock = getSocket(req.instanceId);
        if (!sock) return res.status(400).json({ error: 'Session not active' });
        if (!messageId || !to) return res.status(400).json({ error: 'messageId and to are required' });

        try {
            let jid = formatJid(to);
            if (!jid.includes('@g.us')) {
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.exists) jid = result.jid;
                else return res.status(400).json({ error: 'El número no existe en WhatsApp' });
            }

            await sock.readMessages([{ remoteJid: jid, id: messageId }]);
            res.json({ success: true, status: 'read', messageId });
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
        const { webhook_url, webhook_message_received, webhook_message_ack, instance_name } = req.body;
        
        const updateData = { 
            webhook_url: webhook_url !== undefined ? webhook_url : req.instance.webhook_url,
            webhook_message_received: webhook_message_received !== undefined ? (webhook_message_received === 'true' || webhook_message_received === true) : req.instance.webhook_message_received,
            webhook_message_ack: webhook_message_ack !== undefined ? (webhook_message_ack === 'true' || webhook_message_ack === true) : req.instance.webhook_message_ack,
        };
        
        if (instance_name !== undefined) {
            updateData.instance_name = instance_name;
        }

        updateInstance(req.instanceId, updateData);
        
        res.json({ success: true, message: 'Settings saved' });
    });
};

module.exports = { initRoutes };
