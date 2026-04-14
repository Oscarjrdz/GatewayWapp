const fs = require('fs');
const path = require('path');

const dataFile = path.resolve(__dirname, '../data/instances.json');

const defaultSettings = {
    webhook_url: '',
    webhook_message_received: false,
    webhook_message_create: false,
    webhook_message_ack: false,
    webhook_message_download_media: false,
    messages_sent: 0,
    messages_received: 0,
    instance_name: ''
};

// ─── In-Memory Cache ─────────────────────────────────────────────────────────
// Reads disk ONCE on startup, then serves from memory.
// Writes are debounced (max once every 5 seconds) to prevent I/O thrashing.

let _cache = null;
let _dirty = false;
let _flushTimer = null;

function _loadFromDisk() {
    if (!fs.existsSync(dataFile)) {
        const dir = path.dirname(dataFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dataFile, JSON.stringify({}));
        return {};
    }
    const data = fs.readFileSync(dataFile, 'utf8');
    try {
        return JSON.parse(data);
    } catch {
        return {};
    }
}

function _flushToDisk() {
    if (!_dirty || !_cache) return;
    try {
        fs.writeFileSync(dataFile, JSON.stringify(_cache, null, 2));
        _dirty = false;
    } catch (err) {
        console.error('[Store] Failed to write instances.json:', err.message);
    }
}

function _scheduleSave() {
    _dirty = true;
    if (_flushTimer) return; // Already scheduled
    _flushTimer = setTimeout(() => {
        _flushToDisk();
        _flushTimer = null;
    }, 5000); // Debounced: max once every 5 seconds
}

// Force immediate save (used by graceful shutdown)
function flushNow() {
    if (_flushTimer) {
        clearTimeout(_flushTimer);
        _flushTimer = null;
    }
    _flushToDisk();
}

const getInstances = () => {
    if (!_cache) _cache = _loadFromDisk();
    return _cache;
};

const saveInstances = (data) => {
    _cache = data;
    _scheduleSave();
};

const getInstance = (id) => {
    const instances = getInstances();
    return instances[id] || null;
};

const updateInstance = (id, data) => {
    const instances = getInstances();
    instances[id] = { ...instances[id], ...data };
    _scheduleSave();
    return instances[id];
};

const deleteInstance = (id) => {
    const instances = getInstances();
    delete instances[id];
    _scheduleSave();
};

module.exports = {
    getInstances,
    getInstance,
    updateInstance,
    deleteInstance,
    defaultSettings,
    flushNow
};

