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
    messages_received: 0
};

const getInstances = () => {
    if (!fs.existsSync(dataFile)) {
        fs.writeFileSync(dataFile, JSON.stringify({}));
    }
    const data = fs.readFileSync(dataFile, 'utf8');
    try {
        return JSON.parse(data);
    } catch {
        return {};
    }
};

const saveInstances = (data) => {
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
};

const getInstance = (id) => {
    const instances = getInstances();
    return instances[id] || null;
};

const updateInstance = (id, data) => {
    const instances = getInstances();
    instances[id] = { ...instances[id], ...data };
    saveInstances(instances);
    return instances[id];
};

const deleteInstance = (id) => {
    const instances = getInstances();
    delete instances[id];
    saveInstances(instances);
};

module.exports = {
    getInstances,
    getInstance,
    updateInstance,
    deleteInstance,
    defaultSettings
};
