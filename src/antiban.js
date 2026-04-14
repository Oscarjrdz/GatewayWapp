/**
 * ─── ANTI-BAN SHIELD v2 ──────────────────────────────────────────────────────
 * Enterprise-grade anti-detection engine for WhatsApp Gateway.
 * 
 * Implements 9 layers of protection:
 * 1. Humanizer (typing indicators + character-based delay)
 * 2. Rate Limiter (per-instance, per-hour, per-day)
 * 3. Smart Message Queue (FIFO with priority + jitter)
 * 4. Content Fingerprint Variation
 * 5. Health Monitor + Response Rate Tracking
 * 6. Multi-Instance Aware (respects load balancer)
 * 7. Warm-Up Protocol (for new/reconnected numbers)
 * 8. Risk Score Calculator (Whapi-inspired Safety Meter)
 * 9. Known Contact Registry (persisted to disk)
 * ──────────────────────────────────────────────────────────────────────────────
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
    // Rate limits — MONITOR ONLY, never block
    // Set extremely high so they only serve as counters for /antiban/health
    maxMessagesPerHour: 9999,     // Effectively unlimited — just tracks metrics
    maxMessagesPerDay: 9999,      // Effectively unlimited — just tracks metrics
    warningThreshold: 0.95,       // Only warn at 95% (which is ~9500 msgs, basically never)
    
    // Humanizer delays (milliseconds) — THE CORE PROTECTION
    typingDelayPerChar: 25,       // ~25ms per character (fast but realistic)
    typingMinDelay: 1000,         // Minimum 1 second of "typing"
    typingMaxDelay: 3000,         // Maximum 3 seconds
    
    // Smart delays between messages — keeps it natural without being slow
    baseDelayMin: 1500,           // 1.5 seconds minimum between messages
    baseDelayMax: 4000,           // 4 seconds maximum between messages
    
    // Fatigue simulation — fixed pauses
    burstPauseEvery: 20,          // Every 20 messages...
    burstPauseMin: 5000,          // ...pause for exactly 5 seconds
    burstPauseMax: 5000,
    longBreakEvery: 50,           // Every 50 messages...
    longBreakMin: 10000,          // ...pause for exactly 10 seconds
    longBreakMax: 10000,
    
    // Warm-up — progressive limits for new numbers
    // Based on Whapi recommendation: start low, scale gradually over 3 weeks
    warmupSchedule: [
        { days: 1,  maxPerDay: 20 },    // Day 1: max 20 messages
        { days: 3,  maxPerDay: 50 },    // Days 2-3: max 50
        { days: 7,  maxPerDay: 100 },   // Days 4-7: max 100
        { days: 14, maxPerDay: 300 },   // Week 2: max 300
        { days: 21, maxPerDay: 500 },   // Week 3: max 500
        // After day 21: unlimited (uses maxMessagesPerDay)
    ],
    
    // Queue
    maxQueueSize: 1000,
    queueProcessIntervalMs: 500,   // Check queue every 500ms
    
    // Priority (lower = higher priority)
    PRIORITY_REPLY: 1,            // Replies to incoming messages (fastest)
    PRIORITY_NORMAL: 5,           // Regular outgoing messages
    PRIORITY_BROADCAST: 10,       // Bulk/broadcast messages
};

// ─── Instance Metrics Store ──────────────────────────────────────────────────

const instanceMetrics = {};

// ─── Persistence: Known Contacts & Unique Recipients ─────────────────────────

const CONTACTS_FILE = path.resolve(__dirname, '../data/antiban_contacts.json');

function loadPersistedContacts() {
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
            // Convert arrays back to Sets per instance
            const result = {};
            for (const [id, data] of Object.entries(raw)) {
                result[id] = {
                    knownContacts: new Set(data.knownContacts || []),
                    uniqueRecipients: new Set(data.uniqueRecipients || []),
                };
            }
            return result;
        }
    } catch (err) {
        console.error('[AntiBan] Failed to load persisted contacts:', err.message);
    }
    return {};
}

function savePersistedContacts() {
    try {
        const serializable = {};
        for (const [id, metrics] of Object.entries(instanceMetrics)) {
            serializable[id] = {
                knownContacts: Array.from(metrics.knownContacts || []),
                uniqueRecipients: Array.from(metrics.uniqueRecipients || []),
            };
        }
        const dir = path.dirname(CONTACTS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify(serializable, null, 2));
    } catch (err) {
        console.error('[AntiBan] Failed to save persisted contacts:', err.message);
    }
}

// Debounced save — writes at most once every 30 seconds
let _saveTimer = null;
function debouncedSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
        savePersistedContacts();
        _saveTimer = null;
    }, 30000);
}

// Load persisted data on startup
const _persistedContacts = loadPersistedContacts();

function getMetrics(instanceId) {
    if (!instanceMetrics[instanceId]) {
        const persisted = _persistedContacts[instanceId];
        instanceMetrics[instanceId] = {
            sentThisHour: 0,
            sentToday: 0,
            receivedThisHour: 0,
            receivedToday: 0,
            hourStartedAt: Date.now(),
            dayStartedAt: Date.now(),
            totalSentLifetime: 0,
            consecutiveCount: 0,       // For fatigue simulation
            firstConnectedAt: null,    // For warm-up protocol
            lastMessageAt: null,
            recentMessages: [],        // Timestamps of last 100 messages for analysis
            queuedCount: 0,
            droppedCount: 0,
            // Layer 8+9: Persisted contact data (restored from disk)
            knownContacts: persisted?.knownContacts || new Set(),
            uniqueRecipients: persisted?.uniqueRecipients || new Set(),
        };
    }
    return instanceMetrics[instanceId];
}

function resetHourlyIfNeeded(metrics) {
    const elapsed = Date.now() - metrics.hourStartedAt;
    if (elapsed >= 3600000) { // 1 hour
        metrics.sentThisHour = 0;
        metrics.receivedThisHour = 0;
        metrics.hourStartedAt = Date.now();
        metrics.consecutiveCount = 0;
    }
}

function resetDailyIfNeeded(metrics) {
    const elapsed = Date.now() - metrics.dayStartedAt;
    if (elapsed >= 86400000) { // 24 hours
        metrics.sentToday = 0;
        metrics.receivedToday = 0;
        metrics.dayStartedAt = Date.now();
    }
}

// ─── Utility: Gaussian Random ────────────────────────────────────────────────

function gaussianRandom(min, max) {
    // Box-Muller transform for more natural distribution
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    // Map to 0-1 range
    num = (num + 3) / 6; // ~99.7% within 0-1
    num = Math.max(0, Math.min(1, num));
    return Math.floor(min + num * (max - min));
}

function randomDelay(min, max) {
    return gaussianRandom(min, max);
}

// ─── Layer 1: Humanizer ──────────────────────────────────────────────────────

/**
 * Simulates human typing behavior before sending a message.
 * 1. Sends "composing" (typing indicator)
 * 2. Waits proportional to message length
 * 3. Returns control to caller to send the actual message
 * 4. Sends "paused" after message is sent
 */
async function humanize(sock, jid, messageText, config = DEFAULT_CONFIG) {
    try {
        // Calculate typing duration based on message length
        const textLen = (messageText || '').length;
        let typingDelay = textLen * config.typingDelayPerChar;
        typingDelay = Math.max(config.typingMinDelay, Math.min(config.typingMaxDelay, typingDelay));
        
        // Add jitter (±20%)
        const jitter = typingDelay * 0.2;
        typingDelay += randomDelay(-jitter, jitter);
        typingDelay = Math.max(config.typingMinDelay, typingDelay);
        
        // 1. Show "typing..."
        await sock.sendPresenceUpdate('composing', jid);
        
        // 2. Wait (simulating human typing)
        await new Promise(r => setTimeout(r, typingDelay));
        
    } catch (err) {
        // Never let humanizer errors prevent message delivery
        console.error(`[AntiBan] Humanizer error: ${err.message}`);
    }
}

async function humanizeAfter(sock, jid) {
    try {
        // Brief pause before stopping typing indicator
        await new Promise(r => setTimeout(r, randomDelay(200, 500)));
        await sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
        // Silent — non-critical
    }
}

// ─── Layer 2: Rate Limiter ───────────────────────────────────────────────────

/**
 * Checks if an instance is allowed to send a message right now.
 * Returns { allowed, reason, waitMs }
 */
function checkRateLimit(instanceId, config = DEFAULT_CONFIG) {
    const metrics = getMetrics(instanceId);
    resetHourlyIfNeeded(metrics);
    resetDailyIfNeeded(metrics);
    
    // Check warm-up limits
    const warmupLimit = getWarmupLimit(instanceId, config);
    if (warmupLimit !== null && metrics.sentToday >= warmupLimit) {
        return {
            allowed: false,
            reason: `Warm-up limit reached (${warmupLimit}/day). Account is still warming up.`,
            waitMs: 86400000 - (Date.now() - metrics.dayStartedAt),
            warmup: true
        };
    }
    
    // Check daily limit
    const dailyLimit = warmupLimit || config.maxMessagesPerDay;
    if (metrics.sentToday >= dailyLimit) {
        const waitMs = 86400000 - (Date.now() - metrics.dayStartedAt);
        return {
            allowed: false,
            reason: `Daily limit reached (${dailyLimit}). Resets in ${Math.round(waitMs / 60000)} minutes.`,
            waitMs
        };
    }
    
    // Check hourly limit
    if (metrics.sentThisHour >= config.maxMessagesPerHour) {
        const waitMs = 3600000 - (Date.now() - metrics.hourStartedAt);
        return {
            allowed: false,
            reason: `Hourly limit reached (${config.maxMessagesPerHour}). Resets in ${Math.round(waitMs / 60000)} minutes.`,
            waitMs
        };
    }
    
    // Warning threshold
    const hourlyPct = metrics.sentThisHour / config.maxMessagesPerHour;
    const dailyPct = metrics.sentToday / dailyLimit;
    if (hourlyPct >= config.warningThreshold || dailyPct >= config.warningThreshold) {
        console.warn(`[AntiBan][${instanceId}] ⚠️ WARNING: Approaching rate limit — Hour: ${metrics.sentThisHour}/${config.maxMessagesPerHour} (${Math.round(hourlyPct*100)}%), Day: ${metrics.sentToday}/${dailyLimit} (${Math.round(dailyPct*100)}%)`);
    }
    
    return { allowed: true, reason: null, waitMs: 0 };
}

function recordMessageSent(instanceId, recipientJid) {
    const metrics = getMetrics(instanceId);
    metrics.sentThisHour++;
    metrics.sentToday++;
    metrics.totalSentLifetime++;
    metrics.consecutiveCount++;
    metrics.lastMessageAt = Date.now();
    metrics.recentMessages.push(Date.now());
    // Keep only last 100
    if (metrics.recentMessages.length > 100) {
        metrics.recentMessages.shift();
    }
    // Track unique recipients for contact coverage analysis
    if (recipientJid) {
        metrics.uniqueRecipients.add(recipientJid);
        debouncedSave();
    }
}

// ─── Layer 8: Response Rate Tracking ─────────────────────────────────────────

function recordMessageReceived(instanceId) {
    const metrics = getMetrics(instanceId);
    metrics.receivedThisHour++;
    metrics.receivedToday++;
}

// ─── Layer 9: Known Contact Registry ─────────────────────────────────────────

/**
 * Records a JID as a "known contact" — someone who has messaged us.
 */
function recordKnownContact(instanceId, jid) {
    const metrics = getMetrics(instanceId);
    const sizeBefore = metrics.knownContacts.size;
    metrics.knownContacts.add(jid);
    if (metrics.knownContacts.size > sizeBefore) {
        debouncedSave();
    }
}


/**
 * Calculates the delay to wait BEFORE sending the next message.
 * Includes fatigue simulation (longer pauses every N messages).
 */
function calculateSmartDelay(instanceId, config = DEFAULT_CONFIG) {
    const metrics = getMetrics(instanceId);
    const count = metrics.consecutiveCount;
    
    // Long break every N messages
    if (count > 0 && count % config.longBreakEvery === 0) {
        const breakMs = randomDelay(config.longBreakMin, config.longBreakMax);
        console.log(`[AntiBan][${instanceId}] 🛏️ Long break: ${Math.round(breakMs / 1000)}s after ${count} consecutive messages`);
        return breakMs;
    }
    
    // Burst pause every N messages
    if (count > 0 && count % config.burstPauseEvery === 0) {
        const pauseMs = randomDelay(config.burstPauseMin, config.burstPauseMax);
        console.log(`[AntiBan][${instanceId}] ☕ Burst pause: ${Math.round(pauseMs / 1000)}s after ${count} consecutive messages`);
        return pauseMs;
    }
    
    // Normal jittered delay between messages
    return randomDelay(config.baseDelayMin, config.baseDelayMax);
}

// ─── Layer 4: Content Fingerprint Variation ──────────────────────────────────

// Only use zero-width chars that DON'T participate in emoji sequences
// ❌ U+200D (ZWJ) REMOVED — it's used to compose emojis like 👨‍👩‍👧
// ❌ U+FEFF (BOM) REMOVED — causes rendering issues in some WhatsApp clients
const ZERO_WIDTH_CHARS = [
    '\u200B', // Zero-width space (safe — never part of emoji sequences)
    '\u200C', // Zero-width non-joiner (safe — breaks ligatures, not emojis)
];

/**
 * Adds invisible fingerprint variations to text to prevent
 * WhatsApp from detecting identical mass messages.
 * The text looks exactly the same to humans but has a unique hash.
 * 
 * IMPORTANT: Uses Array.from() to iterate full Unicode codepoints and
 * only inserts at safe boundaries (after spaces/punctuation), never
 * adjacent to emojis or inside multi-byte characters.
 */
function fingerprintText(text) {
    if (!text || typeof text !== 'string') return text;
    
    // Iterate by full Unicode codepoints (emojis = 1 element, not 2 surrogates)
    const chars = Array.from(text);
    const safePositions = [];
    
    // Helper: check if a codepoint is an emoji or emoji-component
    function isEmoji(char) {
        if (!char) return false;
        const cp = char.codePointAt(0);
        return (
            (cp >= 0x1F600 && cp <= 0x1F64F) || // Emoticons
            (cp >= 0x1F300 && cp <= 0x1F5FF) || // Misc Symbols & Pictographs
            (cp >= 0x1F680 && cp <= 0x1F6FF) || // Transport & Map
            (cp >= 0x1F700 && cp <= 0x1F77F) || // Alchemical Symbols
            (cp >= 0x1F780 && cp <= 0x1F7FF) || // Geometric Shapes Extended
            (cp >= 0x1F800 && cp <= 0x1F8FF) || // Supplemental Arrows-C
            (cp >= 0x1F900 && cp <= 0x1F9FF) || // Supplemental Symbols
            (cp >= 0x1FA00 && cp <= 0x1FA6F) || // Chess Symbols
            (cp >= 0x1FA70 && cp <= 0x1FAFF) || // Symbols Extended-A
            (cp >= 0x2600 && cp <= 0x26FF) ||   // Misc Symbols
            (cp >= 0x2700 && cp <= 0x27BF) ||   // Dingbats
            (cp >= 0xFE00 && cp <= 0xFE0F) ||   // Variation Selectors
            (cp >= 0x200D && cp <= 0x200D) ||   // ZWJ (part of compound emojis)
            (cp >= 0xE0020 && cp <= 0xE007F) || // Tags (flag sequences)
            (cp >= 0x1F1E0 && cp <= 0x1F1FF)    // Regional Indicators (flags)
        );
    }
    
    for (let i = 0; i <= chars.length; i++) {
        const prevChar = chars[i - 1];
        const nextChar = chars[i];
        
        // Never insert adjacent to any emoji character
        if (isEmoji(prevChar) || isEmoji(nextChar)) continue;
        
        // Position 0 (start) and end are safe if not near emoji
        if (i === 0 || i === chars.length) {
            safePositions.push(i);
            continue;
        }
        
        // Safe to insert after: spaces, newlines, punctuation
        if (/[\s,.;:!?¡¿\-–—\n\r\t()\[\]{}]/.test(prevChar)) {
            safePositions.push(i);
        }
    }
    
    // If very few safe positions, just append zero-width at the very end
    if (safePositions.length < 2) {
        const zwc = ZERO_WIDTH_CHARS[Math.floor(Math.random() * ZERO_WIDTH_CHARS.length)];
        return text + zwc;
    }
    
    // Insert 2-4 random zero-width chars at safe positions only
    const numInserts = Math.min(2 + Math.floor(Math.random() * 3), safePositions.length);
    
    // Shuffle and pick positions (avoid duplicates)
    const shuffled = safePositions.sort(() => Math.random() - 0.5);
    const chosen = shuffled.slice(0, numInserts).sort((a, b) => b - a);
    
    for (const pos of chosen) {
        const zwc = ZERO_WIDTH_CHARS[Math.floor(Math.random() * ZERO_WIDTH_CHARS.length)];
        chars.splice(pos, 0, zwc);
    }
    
    return chars.join('');
}

// ─── Layer 5: Health Monitor ─────────────────────────────────────────────────

/**
 * Returns a health report for all instances or a specific one.
 */
function getHealthReport(instanceId = null) {
    const report = {};
    const ids = instanceId ? [instanceId] : Object.keys(instanceMetrics);
    
    for (const id of ids) {
        const metrics = getMetrics(id);
        resetHourlyIfNeeded(metrics);
        resetDailyIfNeeded(metrics);
        
        const config = DEFAULT_CONFIG;
        const warmupLimit = getWarmupLimit(id, config);
        const effectiveDailyLimit = warmupLimit || config.maxMessagesPerDay;
        
        const hourlyPct = Math.round((metrics.sentThisHour / config.maxMessagesPerHour) * 100);
        const dailyPct = Math.round((metrics.sentToday / effectiveDailyLimit) * 100);
        
        const hourRemainingMs = 3600000 - (Date.now() - metrics.hourStartedAt);
        const dayRemainingMs = 86400000 - (Date.now() - metrics.dayStartedAt);
        
        // Calculate msgs/minute rate over last 10 minutes
        const tenMinsAgo = Date.now() - 600000;
        const recentCount = metrics.recentMessages.filter(ts => ts > tenMinsAgo).length;
        const msgsPerMinute = (recentCount / 10).toFixed(1);
        
        // Response Rate calculation
        const responseRate = metrics.sentToday > 0 
            ? Math.round((metrics.receivedToday / metrics.sentToday) * 100)
            : null;
        const responseRateStatus = (() => {
            if (metrics.sentToday < 10) return '⚪ Insufficient data';
            if (responseRate >= 30) return '🟢 Healthy';
            if (responseRate >= 15) return '🟡 Warning — try to increase engagement';
            return '🔴 DANGER — reduce outbound messaging';
        })();
        
        report[id] = {
            status: hourlyPct >= 100 || dailyPct >= 100 ? '🔴 BLOCKED' :
                    hourlyPct >= 80 || dailyPct >= 80 ? '🟡 WARNING' : '🟢 HEALTHY',
            sentThisHour: metrics.sentThisHour,
            receivedThisHour: metrics.receivedThisHour,
            maxPerHour: config.maxMessagesPerHour,
            hourlyUsage: `${hourlyPct}%`,
            hourResetsIn: `${Math.max(0, Math.round(hourRemainingMs / 60000))} min`,
            sentToday: metrics.sentToday,
            receivedToday: metrics.receivedToday,
            maxPerDay: effectiveDailyLimit,
            dailyUsage: `${dailyPct}%`,
            dayResetsIn: `${Math.max(0, Math.round(dayRemainingMs / 60000))} min`,
            responseRate: responseRate !== null ? `${responseRate}%` : 'N/A',
            responseRateStatus,
            msgsPerMinute,
            totalLifetime: metrics.totalSentLifetime,
            consecutiveCount: metrics.consecutiveCount,
            queuedCount: metrics.queuedCount,
            droppedCount: metrics.droppedCount,
            knownContactsCount: metrics.knownContacts.size,
            uniqueRecipientsCount: metrics.uniqueRecipients.size,
            contactCoverage: metrics.uniqueRecipients.size > 0
                ? `${Math.round((metrics.knownContacts.size / metrics.uniqueRecipients.size) * 100)}%`
                : 'N/A',
            warmup: warmupLimit !== null ? {
                active: true,
                currentLimit: warmupLimit,
                fullLimitAt: metrics.firstConnectedAt
                    ? new Date(metrics.firstConnectedAt + 21 * 86400000).toISOString()
                    : 'unknown'
            } : { active: false },
            lastMessageAt: metrics.lastMessageAt
                ? new Date(metrics.lastMessageAt).toISOString()
                : 'never'
        };
    }
    
    return instanceId ? report[instanceId] : report;
}

// ─── Layer 7: Warm-Up Protocol ───────────────────────────────────────────────

function setFirstConnected(instanceId, timestamp = Date.now()) {
    const metrics = getMetrics(instanceId);
    if (!metrics.firstConnectedAt) {
        metrics.firstConnectedAt = timestamp;
        console.log(`[AntiBan][${instanceId}] 🌡️ Warm-up started. Full limits available after ${new Date(timestamp + 21 * 86400000).toISOString()}`);
    }
}

function getWarmupLimit(instanceId, config = DEFAULT_CONFIG) {
    const metrics = getMetrics(instanceId);
    if (!metrics.firstConnectedAt) return null; // No warm-up tracking
    
    const daysSinceFirstConnect = (Date.now() - metrics.firstConnectedAt) / 86400000;
    
    for (const tier of config.warmupSchedule) {
        if (daysSinceFirstConnect <= tier.days) {
            return tier.maxPerDay;
        }
    }
    
    return null; // Past warm-up period, use full limits
}

/**
 * Skip warm-up for established numbers (already active before this system).
 * Call this for numbers that have been connected for a long time.
 */
function skipWarmup(instanceId) {
    const metrics = getMetrics(instanceId);
    metrics.firstConnectedAt = Date.now() - (22 * 86400000); // Pretend connected 22 days ago
    console.log(`[AntiBan][${instanceId}] 🌡️ Warm-up skipped (established number).`);
}

// ─── Layer 6: Message Queue ──────────────────────────────────────────────────

const messageQueues = {};

class MessageQueue extends EventEmitter {
    constructor(instanceId, config = DEFAULT_CONFIG) {
        super();
        this.instanceId = instanceId;
        this.config = config;
        this.queue = [];
        this.processing = false;
        this.paused = false;
    }
    
    /**
     * Add a message to the queue.
     * @param {Object} job - { sock, jid, content, priority, resolve, reject, isReply }
     */
    enqueue(job) {
        if (this.queue.length >= this.config.maxQueueSize) {
            const metrics = getMetrics(this.instanceId);
            metrics.droppedCount++;
            job.reject(new Error('Message queue full. Try again later.'));
            return;
        }
        
        const metrics = getMetrics(this.instanceId);
        metrics.queuedCount++;
        
        // Insert sorted by priority (lower = higher priority)
        const priority = job.priority || this.config.PRIORITY_NORMAL;
        let inserted = false;
        for (let i = 0; i < this.queue.length; i++) {
            if (priority < (this.queue[i].priority || this.config.PRIORITY_NORMAL)) {
                this.queue.splice(i, 0, { ...job, priority, enqueuedAt: Date.now() });
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            this.queue.push({ ...job, priority, enqueuedAt: Date.now() });
        }
        
        // Start processing if not already
        if (!this.processing) {
            this.processQueue();
        }
    }
    
    async processQueue() {
        if (this.processing) return;
        this.processing = true;
        
        while (this.queue.length > 0) {
            if (this.paused) {
                await new Promise(r => setTimeout(r, 5000)); // Check again in 5s
                continue;
            }
            
            const job = this.queue.shift();
            
            try {
                // Check rate limits
                const rateCheck = checkRateLimit(this.instanceId, this.config);
                if (!rateCheck.allowed) {
                    console.warn(`[AntiBan][${this.instanceId}] 🚫 Rate limited: ${rateCheck.reason}`);
                    // Re-queue the job at the front
                    this.queue.unshift(job);
                    // Wait until the limit resets (max 5 minutes wait per check)
                    const waitMs = Math.min(rateCheck.waitMs, 300000);
                    console.log(`[AntiBan][${this.instanceId}] ⏳ Waiting ${Math.round(waitMs / 1000)}s for rate limit reset...`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
                
                // Calculate smart delay
                const delay = calculateSmartDelay(this.instanceId, this.config);
                if (delay > 0) {
                    console.log(`[AntiBan][${this.instanceId}] ⏱️ Delay: ${Math.round(delay / 1000)}s before next message (queue: ${this.queue.length})`);
                    await new Promise(r => setTimeout(r, delay));
                }
                
                // Determine text content for humanizer
                const textContent = job.content?.text || job.content?.caption || '';
                
                // Humanize: typing indicator + delay
                if (textContent && job.sock) {
                    await humanize(job.sock, job.jid, textContent, this.config);
                }
                
                // Apply content fingerprinting
                if (job.content?.text) {
                    job.content.text = fingerprintText(job.content.text);
                }
                if (job.content?.caption) {
                    job.content.caption = fingerprintText(job.content.caption);
                }
                
                // Send the actual message
                const msg = await job.sock.sendMessage(job.jid, job.content);
                
                // Post-send humanization
                if (textContent) {
                    await humanizeAfter(job.sock, job.jid);
                }
                
                // Record in metrics (pass recipient JID for contact tracking)
                recordMessageSent(this.instanceId, job.jid);
                
                // Resolve the promise
                job.resolve(msg);
                
            } catch (err) {
                console.error(`[AntiBan][${this.instanceId}] ❌ Queue job failed: ${err.message}`);
                job.reject(err);
            }
        }
        
        this.processing = false;
    }
    
    getQueueSize() {
        return this.queue.length;
    }
    
    pause() {
        this.paused = true;
        console.log(`[AntiBan][${this.instanceId}] ⏸️ Queue paused.`);
    }
    
    resume() {
        this.paused = false;
        console.log(`[AntiBan][${this.instanceId}] ▶️ Queue resumed.`);
        if (this.queue.length > 0 && !this.processing) {
            this.processQueue();
        }
    }
    
    clear() {
        const dropped = this.queue.length;
        this.queue.forEach(job => job.reject(new Error('Queue cleared')));
        this.queue = [];
        console.log(`[AntiBan][${this.instanceId}] 🗑️ Queue cleared. ${dropped} messages dropped.`);
    }
}

function getQueue(instanceId, config = DEFAULT_CONFIG) {
    if (!messageQueues[instanceId]) {
        messageQueues[instanceId] = new MessageQueue(instanceId, config);
    }
    return messageQueues[instanceId];
}

// ─── Public API: sendSafe ────────────────────────────────────────────────────

/**
 * The safe replacement for sock.sendMessage().
 * Routes through the full anti-ban pipeline:
 *   Rate Limit → Queue → Smart Delay → Humanize → Fingerprint → Send
 * 
 * @param {string} instanceId - The instance ID
 * @param {object} sock - The Baileys socket
 * @param {string} jid - The recipient JID
 * @param {object} content - The message content (same format as sock.sendMessage)
 * @param {object} options - { priority, isReply, bypass }
 * @returns {Promise<object>} - The message result from Baileys
 */
function sendSafe(instanceId, sock, jid, content, options = {}) {
    // If bypass is set, skip the queue (for system messages, presence, etc.)
    if (options.bypass) {
        return sock.sendMessage(jid, content);
    }
    
    const priority = options.isReply ? DEFAULT_CONFIG.PRIORITY_REPLY : 
                     options.isBroadcast ? DEFAULT_CONFIG.PRIORITY_BROADCAST : 
                     DEFAULT_CONFIG.PRIORITY_NORMAL;
    
    const queue = getQueue(instanceId);
    
    return new Promise((resolve, reject) => {
        queue.enqueue({
            sock,
            jid,
            content,
            priority,
            resolve,
            reject,
            isReply: options.isReply || false
        });
    });
}

/**
 * Quick check if a message can be sent right now (without queueing).
 * Use this to give immediate feedback to the caller.
 */
function canSendNow(instanceId) {
    const check = checkRateLimit(instanceId);
    const queue = getQueue(instanceId);
    return {
        ...check,
        queueSize: queue.getQueueSize(),
        estimatedWaitMs: check.allowed ? 0 : check.waitMs
    };
}

// ─── Layer 8: Risk Score Calculator (Whapi-inspired Safety Meter) ────────────

/**
 * Calculates a risk score (1-3) for an instance, inspired by Whapi's Activity Safety Meter.
 * 
 * Factors:
 * - lifeTime: How long the number has been connected (days)
 * - riskFactorChats: Response rate (ratio received/sent)
 * - riskFactorContacts: % of recipients that are known contacts
 * 
 * Returns: { riskFactor: 1|2|3, lifeTime: 1|2|3, riskFactorChats: 1|2|3, riskFactorContacts: 1|2|3 }
 *   3 = Good, 2 = Attention, 1 = Caution/Danger
 */
function calculateRiskScore(instanceId) {
    const metrics = getMetrics(instanceId);
    resetHourlyIfNeeded(metrics);
    resetDailyIfNeeded(metrics);
    
    // Factor 1: Lifetime (days connected)
    let lifeTime = 1; // Caution by default
    if (metrics.firstConnectedAt) {
        const days = (Date.now() - metrics.firstConnectedAt) / 86400000;
        if (days >= 30) lifeTime = 3;       // 30+ days = Good
        else if (days >= 7) lifeTime = 2;   // 7-30 days = Attention
    }
    
    // Factor 2: Response Rate
    let riskFactorChats = 1;
    if (metrics.sentToday < 10) {
        riskFactorChats = 3; // Not enough data = assume OK
    } else {
        const rate = (metrics.receivedToday / metrics.sentToday) * 100;
        if (rate >= 30) riskFactorChats = 3;      // 30%+ = Good
        else if (rate >= 15) riskFactorChats = 2;  // 15-30% = Attention
    }
    
    // Factor 3: Known Contact Coverage
    let riskFactorContacts = 2; // Default: Attention (no data)
    if (metrics.uniqueRecipients.size > 0) {
        const coverage = (metrics.knownContacts.size / metrics.uniqueRecipients.size) * 100;
        if (coverage >= 50) riskFactorContacts = 3;      // 50%+ known = Good
        else if (coverage >= 20) riskFactorContacts = 2;  // 20-50% = Attention
        else riskFactorContacts = 1;                       // <20% = Danger
    }
    
    // Overall: minimum of all factors (weakest link determines safety)
    const riskFactor = Math.min(lifeTime, riskFactorChats, riskFactorContacts);
    
    return {
        riskFactor,
        riskLabel: riskFactor === 3 ? '🟢 SAFE' : riskFactor === 2 ? '🟡 ATTENTION' : '🔴 DANGER',
        lifeTime,
        lifeTimeLabel: lifeTime === 3 ? 'Good' : lifeTime === 2 ? 'Attention' : 'Caution',
        riskFactorChats,
        riskFactorChatsLabel: riskFactorChats === 3 ? 'Good' : riskFactorChats === 2 ? 'Attention' : 'Caution',
        riskFactorContacts,
        riskFactorContactsLabel: riskFactorContacts === 3 ? 'Good' : riskFactorContacts === 2 ? 'Attention' : 'Caution',
        details: {
            daysConnected: metrics.firstConnectedAt 
                ? Math.round((Date.now() - metrics.firstConnectedAt) / 86400000)
                : 0,
            responseRate: metrics.sentToday > 0 
                ? Math.round((metrics.receivedToday / metrics.sentToday) * 100) 
                : null,
            knownContactsCount: metrics.knownContacts.size,
            uniqueRecipientsCount: metrics.uniqueRecipients.size,
            contactCoverage: metrics.uniqueRecipients.size > 0
                ? Math.round((metrics.knownContacts.size / metrics.uniqueRecipients.size) * 100)
                : null,
        }
    };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    // Core API
    sendSafe,
    canSendNow,
    
    // Humanizer (can be used standalone for reply flows)
    humanize,
    humanizeAfter,
    
    // Rate limiting
    checkRateLimit,
    recordMessageSent,
    
    // Response Rate & Contact Tracking (v2)
    recordMessageReceived,
    recordKnownContact,
    
    // Content protection
    fingerprintText,
    
    // Health & Risk
    getHealthReport,
    calculateRiskScore,
    getMetrics,
    
    // Warm-up
    setFirstConnected,
    skipWarmup,
    
    // Queue management
    getQueue,
    
    // Persistence
    savePersistedContacts,
    
    // Config
    DEFAULT_CONFIG,
};
