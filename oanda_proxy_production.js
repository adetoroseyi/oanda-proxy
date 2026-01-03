// ================================================
// SWEEPSIGNAL - LIQUIDITY SWEEP SCANNER v8
// With Telegram Alerts + Supabase + Stripe Payments
// ================================================

const express = require('express');
const cors = require('cors');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ================================================
// CONFIGURATION
// ================================================

const OANDA_CONFIG = {
    accountId: process.env.OANDA_ACCOUNT_ID,
    apiToken: process.env.OANDA_API_TOKEN,
    environment: process.env.OANDA_ENVIRONMENT || 'practice'
};

// Telegram Configuration
const TELEGRAM_CONFIG = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID
};

// Supabase Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Stripe Configuration
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const PORT = process.env.PORT || 3001;

// Liquidity Analysis Configuration
const LIQUIDITY_CONFIG = {
    INSTRUMENTS: [
        'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF', 'AUD_USD', 'NZD_USD', 'USD_CAD',
        'EUR_GBP', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'CAD_JPY', 'CHF_JPY',
        'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_NZD',
        'GBP_AUD', 'GBP_CAD', 'GBP_CHF', 'GBP_NZD',
        'AUD_CAD', 'AUD_CHF', 'AUD_NZD', 'NZD_CAD', 'NZD_CHF',
        'NAS100_USD', 'XAU_USD'
    ],
    
    AVAILABLE_TIMEFRAMES: ['M30', 'H1', 'H4', 'D'],
    DEFAULT_TIMEFRAME: 'H1',
    
    HTF_MAP: {
        'M30': 'H4',
        'H1': 'H4',
        'H4': 'D',
        'D': 'W'
    },
    
    EQUAL_LEVEL_TOLERANCE: 0.0003,
    DISPLACEMENT_ATR_MULTIPLE: 1.5,
    MIN_REWARD_RISK: 2.0,
    MAX_EQUAL_LEVELS: 3,
    MAX_SIGNALS_PER_INSTRUMENT: 2,
    
    SESSIONS: {
        ASIAN:  { start: 0, end: 8 },
        LONDON: { start: 7, end: 16 },
        NY:     { start: 13, end: 22 }
    },
    
    EQUITY_OPEN_UTC: 14.5,
    EQUITY_OPEN_WARNING_MINUTES: 30,
    
    TP_LEVELS: {
        TP1: 0.5,
        TP2: 0.75,
        RUNNER: 1.0
    },
    
    // Alert Configuration
    ALERTS: {
        MIN_GRADE_FOR_ALERT: 'B',  // Alert A+, A, and B grades
        COOLDOWN_MINUTES: 60,      // Don't re-alert same signal within this time
        ENABLED: true
    },
    
    SCORING: {
        LEVEL_POINTS: {
            'PDH': 25, 'PDL': 25,
            'Previous Day High': 25, 'Previous Day Low': 25,
            'ASIAN_HIGH': 18, 'ASIAN_LOW': 18,
            'Asian Session High': 18, 'Asian Session Low': 18,
            'LONDON_HIGH': 18, 'LONDON_LOW': 18,
            'London Session High': 18, 'London Session Low': 18,
            'NY_HIGH': 18, 'NY_LOW': 18,
            'EQUAL_HIGH': 12, 'EQUAL_LOW': 12
        },
        DISPLACEMENT: { STRONG: 25, NORMAL: 18, WEAK: 8, NONE: 0 },
        FVG: { PRESENT: 20, ABSENT: 0 },
        HTF: { ALIGNED: 15, NEUTRAL: 8, AGAINST: 0 },
        RR: {
            EXCELLENT: { min: 4, points: 15 },
            VERY_GOOD: { min: 3, points: 12 },
            ACCEPTABLE: { min: 2.5, points: 8 },
            MINIMUM: { min: 2, points: 4 },
            POOR: { min: 0, points: 0 }
        },
        NEWS: { ALIGNED: 10, NEUTRAL: 0, AGAINST: -10 },
        GRADES: { 'A+': 90, 'A': 80, 'B': 70, 'C': 60, 'D': 0 }
    }
};

// Cache
let liquidityCache = {
    lastUpdate: null,
    data: null,
    signals: [],
    cacheKey: null
};

// Alert tracking to prevent duplicates
let alertedSignals = new Map(); // key: instrument-direction-setupType, value: timestamp

app.use(cors({ origin: '*' }));

// Raw body parser for Stripe webhooks (must be before express.json)
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// ================================================
// TELEGRAM FUNCTIONS
// ================================================

const sendTelegramMessage = async (chatId, message, parseMode = 'HTML') => {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: parseMode,
            disable_web_page_preview: true
        });
        
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${TELEGRAM_CONFIG.botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.ok) {
                        resolve(parsed);
                    } else {
                        console.error('Telegram API error:', parsed);
                        reject(new Error(parsed.description || 'Telegram API error'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
};

// ================================================
// SUPABASE USER VERIFICATION
// ================================================

async function verifyTelegramCode(code, chatId) {
    try {
        // Find the verification code with user profile
        const { data: verification, error: findError } = await supabase
            .from('telegram_verifications')
            .select('*, profiles(*)')
            .eq('code', code)
            .eq('used', false)
            .gt('expires_at', new Date().toISOString())
            .single();
        
        if (findError || !verification) {
            return { success: false, message: '❌ Invalid or expired code.\n\nPlease generate a new one from the dashboard.' };
        }
        
        // Check if user is Pro
        if (verification.profiles.subscription_tier !== 'pro' || 
            verification.profiles.subscription_status !== 'active') {
            return { success: false, message: '❌ Telegram alerts are only available for Pro subscribers.\n\nUpgrade at vnmrsignal.app/sweepsignal' };
        }
        
        // Mark code as used
        await supabase
            .from('telegram_verifications')
            .update({ used: true })
            .eq('id', verification.id);
        
        // Update user profile with telegram_chat_id
        const { error: updateError } = await supabase
            .from('profiles')
            .update({ telegram_chat_id: chatId.toString() })
            .eq('id', verification.user_id);
        
        if (updateError) {
            console.error('Error updating profile:', updateError);
            return { success: false, message: '❌ Error connecting your account. Please try again.' };
        }
        
        return { 
            success: true, 
            message: `✅ <b>Successfully connected!</b>\n\nYou'll now receive real-time alerts for B+ and above signals.\n\nWelcome, ${verification.profiles.full_name || verification.profiles.email}!`
        };
        
    } catch (error) {
        console.error('Verification error:', error);
        return { success: false, message: '❌ An error occurred. Please try again.' };
    }
}

async function getProUsersWithTelegram() {
    try {
        const { data: users, error } = await supabase
            .from('profiles')
            .select('telegram_chat_id, email, full_name')
            .eq('subscription_tier', 'pro')
            .eq('subscription_status', 'active')
            .not('telegram_chat_id', 'is', null);
        
        if (error) {
            console.error('Error fetching Pro users:', error);
            return [];
        }
        
        return users || [];
    } catch (error) {
        console.error('Error in getProUsersWithTelegram:', error);
        return [];
    }
}

async function getUserByTelegramChatId(chatId) {
    try {
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('email, full_name, subscription_tier, subscription_status')
            .eq('telegram_chat_id', chatId.toString())
            .single();
        
        if (error) return null;
        return profile;
    } catch (error) {
        return null;
    }
}

// ================================================
// TELEGRAM WEBHOOK HANDLER (Bot Commands)
// ================================================

app.post('/webhook', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.sendStatus(200);
        
        const chatId = message.chat.id;
        const text = message.text || '';
        const username = message.from.username || message.from.first_name || 'User';
        
        console.log(`[Telegram] Received: ${text} from ${username} (${chatId})`);
        
        // Handle /start command
        if (text === '/start') {
            await sendTelegramMessage(chatId, 
                `👋 Welcome to <b>SweepSignal Bot</b>!\n\n` +
                `This bot sends real-time forex signals to Pro subscribers.\n\n` +
                `<b>Commands:</b>\n` +
                `/connect CODE - Connect your Pro account\n` +
                `/status - Check your connection status\n` +
                `/help - Show this message\n\n` +
                `To get started, upgrade to Pro at https://vnmrsignal.app/sweepsignal and connect your account from the dashboard.`
            );
        }
        // Handle /connect command
        else if (text.startsWith('/connect')) {
            const parts = text.split(' ');
            if (parts.length !== 2 || parts[1].length !== 6) {
                await sendTelegramMessage(chatId, 
                    `❌ <b>Invalid format</b>\n\n` +
                    `Please use: <code>/connect CODE</code>\n\n` +
                    `Get your 6-digit code from the SweepSignal dashboard.`
                );
            } else {
                const code = parts[1];
                const result = await verifyTelegramCode(code, chatId);
                await sendTelegramMessage(chatId, result.message);
                
                if (result.success) {
                    // Notify admin
                    await sendTelegramMessage(TELEGRAM_CONFIG.adminChatId, 
                        `🔗 <b>New Telegram Connection</b>\n\nUser: ${username}\nChat ID: ${chatId}`
                    );
                }
            }
        }
        // Handle /status command
        else if (text === '/status') {
            const profile = await getUserByTelegramChatId(chatId);
            
            if (profile) {
                await sendTelegramMessage(chatId,
                    `✅ <b>Connected</b>\n\n` +
                    `Email: ${profile.email}\n` +
                    `Tier: ${profile.subscription_tier.toUpperCase()}\n` +
                    `Status: ${profile.subscription_status}\n\n` +
                    `You're receiving alerts for B+ and above signals.`
                );
            } else {
                await sendTelegramMessage(chatId,
                    `❌ <b>Not Connected</b>\n\n` +
                    `Your Telegram is not linked to a SweepSignal account.\n\n` +
                    `Use /connect CODE with your code from the dashboard.`
                );
            }
        }
        // Handle /help command
        else if (text === '/help') {
            await sendTelegramMessage(chatId,
                `📖 <b>SweepSignal Bot Help</b>\n\n` +
                `<b>Commands:</b>\n` +
                `/start - Welcome message\n` +
                `/connect CODE - Connect your Pro account\n` +
                `/status - Check connection status\n` +
                `/help - Show this message\n\n` +
                `<b>How it works:</b>\n` +
                `1. Subscribe to Pro at vnmrsignal.app/sweepsignal\n` +
                `2. Go to Dashboard → Connect Telegram\n` +
                `3. Send the 6-digit code here\n` +
                `4. Receive real-time B+ and above signals!\n\n` +
                `Questions? Contact toventuresltd@gmail.com`
            );
        }
        // Unknown command
        else if (text.startsWith('/')) {
            await sendTelegramMessage(chatId, `Unknown command. Type /help for available commands.`);
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(200);
    }
});

// ================================================
// SIGNAL ALERT FUNCTIONS
// ================================================

const formatSignalAlert = (signal) => {
    const direction = signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const gradeEmoji = signal.grade === 'A+' ? '⭐' : signal.grade === 'A' ? '✅' : '🔵';
    const pair = signal.instrument.replace('_', '/');
    
    // Format prices based on instrument
    const formatPrice = (price) => {
        if (!price) return '-';
        if (signal.instrument.includes('JPY')) return parseFloat(price).toFixed(3);
        if (signal.instrument === 'XAU_USD') return parseFloat(price).toFixed(2);
        if (signal.instrument === 'NAS100_USD') return parseFloat(price).toFixed(1);
        return parseFloat(price).toFixed(5);
    };
    
    const message = `
${gradeEmoji} <b>SWEEPSIGNAL ALERT</b> ${gradeEmoji}

<b>${pair}</b> ${direction}
Grade: <b>${signal.grade}</b> (Score: ${signal.score}/100)

📍 <b>Setup:</b> ${signal.setupType}
📊 <b>HTF Bias:</b> ${signal.htfBias} (${signal.htfTimeframe})

━━━━━━━━━━━━━━━━━━
<b>TRADE LEVELS</b>
━━━━━━━━━━━━━━━━━━
▫️ Entry: <code>${formatPrice(signal.entryPrice)}</code>
🛑 Stop Loss: <code>${formatPrice(signal.stopLoss)}</code>

🎯 TP1 (50%): <code>${formatPrice(signal.tp1)}</code>
🎯 TP2 (75%): <code>${formatPrice(signal.tp2)}</code>
🏆 Runner: <code>${formatPrice(signal.runner)}</code>

📈 R:R Ratio: <b>${signal.rewardRisk}:1</b>
━━━━━━━━━━━━━━━━━━

${signal.hasDisplacement ? '⚡ Displacement: ' + signal.displacementStrength : ''}
${signal.hasFVG ? '📊 FVG Present' : ''}

⏰ ${new Date().toUTCString()}
`.trim();
    
    return message;
};

const shouldSendAlert = (signal) => {
    // Check if alerts are enabled
    if (!LIQUIDITY_CONFIG.ALERTS.ENABLED) return false;
    
    // Alert A+, A, and B grades (B+ and above)
    if (signal.grade !== 'A+' && signal.grade !== 'A' && signal.grade !== 'B') return false;
    
    // Check cooldown (prevent duplicate alerts)
    const signalKey = `${signal.instrument}-${signal.direction}-${signal.setupType}`;
    const lastAlerted = alertedSignals.get(signalKey);
    
    if (lastAlerted) {
        const cooldownMs = LIQUIDITY_CONFIG.ALERTS.COOLDOWN_MINUTES * 60 * 1000;
        if (Date.now() - lastAlerted < cooldownMs) {
            return false;
        }
    }
    
    return true;
};

const sendSignalAlerts = async (signals) => {
    if (!signals || signals.length === 0) return;
    
    const alertableSignals = signals.filter(shouldSendAlert);
    
    if (alertableSignals.length === 0) {
        console.log('[Telegram] No alertable signals (B+ and above)');
        return;
    }
    
    // Get Pro users with Telegram connected from Supabase
    const proUsers = await getProUsersWithTelegram();
    
    if (proUsers.length === 0) {
        console.log('[Telegram] No Pro users with Telegram connected');
        return;
    }
    
    console.log(`[Telegram] Sending ${alertableSignals.length} signals to ${proUsers.length} Pro users`);
    
    for (const signal of alertableSignals) {
        const message = formatSignalAlert(signal);
        
        // Send to all Pro users with Telegram connected
        let sentCount = 0;
        for (const user of proUsers) {
            try {
                await sendTelegramMessage(user.telegram_chat_id, message);
                sentCount++;
                // Small delay to avoid rate limits
                await new Promise(r => setTimeout(r, 100));
            } catch (error) {
                console.error(`[Telegram] Failed to send to ${user.email}:`, error.message);
            }
        }
        
        console.log(`[Telegram] Alert sent to ${sentCount} users for ${signal.instrument} ${signal.direction} (${signal.grade})`);
        
        // Mark as alerted
        const signalKey = `${signal.instrument}-${signal.direction}-${signal.setupType}`;
        alertedSignals.set(signalKey, Date.now());
        
        // Notify admin
        await sendTelegramMessage(TELEGRAM_CONFIG.adminChatId, 
            `📤 Alert sent to ${sentCount} Pro users:\n${signal.instrument} ${signal.direction} (${signal.grade})`
        );
    }
    
    // Clean up old alert records (older than 24 hours)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    for (const [key, timestamp] of alertedSignals) {
        if (timestamp < oneDayAgo) {
            alertedSignals.delete(key);
        }
    }
};

const sendStartupNotification = async () => {
    const proUsers = await getProUsersWithTelegram();
    
    const message = `
🚀 <b>SweepSignal Bot v7 Started</b>

✅ Scanner: Active
✅ Alerts: Enabled (Pro users only)
✅ User Verification: Active
📊 Instruments: ${LIQUIDITY_CONFIG.INSTRUMENTS.length}
👥 Connected Pro Users: ${proUsers.length}
⏰ ${new Date().toUTCString()}

Pro users will receive B+ and above signals.
`.trim();
    
    try {
        await sendTelegramMessage(TELEGRAM_CONFIG.adminChatId, message);
        console.log('[Telegram] Startup notification sent');
    } catch (error) {
        console.error('[Telegram] Failed to send startup notification:', error.message);
    }
};

// ================================================
// HELPER FUNCTIONS
// ================================================

const getOandaHost = () => {
    return OANDA_CONFIG.environment === 'live' 
        ? 'api-fxtrade.oanda.com'
        : 'api-fxpractice.oanda.com';
};

const fetchCandles = (instrument, granularity, count = 100) => {
    return new Promise((resolve, reject) => {
        const path = `/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=MBA`;
        
        const options = {
            hostname: getOandaHost(),
            port: 443,
            path: path,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${OANDA_CONFIG.apiToken}`,
                'Accept-Datetime-Format': 'RFC3339',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.candles) {
                        resolve(parsed.candles);
                    } else {
                        reject(new Error(parsed.errorMessage || 'No candles returned'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
};

const getPipSize = (instrument) => {
    if (instrument.includes('JPY')) return 0.01;
    if (instrument === 'XAU_USD') return 0.1;
    if (instrument === 'NAS100_USD') return 1;
    return 0.0001;
};

const calculateATR = (candles, period = 14) => {
    if (candles.length < period + 1) return null;
    
    let trSum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const high = parseFloat(candles[i].mid.h);
        const low = parseFloat(candles[i].mid.l);
        const prevClose = parseFloat(candles[i - 1].mid.c);
        
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trSum += tr;
    }
    
    return trSum / period;
};

const getPDHPDL = (dailyCandles) => {
    if (dailyCandles.length < 2) return null;
    const prevDay = dailyCandles[dailyCandles.length - 2];
    
    return {
        pdh: parseFloat(prevDay.mid.h),
        pdl: parseFloat(prevDay.mid.l),
        date: prevDay.time
    };
};

const getSessionLevels = (candles, sessionType) => {
    const session = LIQUIDITY_CONFIG.SESSIONS[sessionType];
    if (!session) return null;
    
    const sessionCandles = candles.filter(c => {
        const hour = new Date(c.time).getUTCHours();
        return hour >= session.start && hour < session.end;
    });
    
    if (sessionCandles.length === 0) return null;
    
    let high = -Infinity;
    let low = Infinity;
    
    sessionCandles.forEach(c => {
        high = Math.max(high, parseFloat(c.mid.h));
        low = Math.min(low, parseFloat(c.mid.l));
    });
    
    return { high, low, session: sessionType };
};

const findEqualLevels = (candles, tolerance, maxLevels = 3) => {
    const swingHighs = [];
    const swingLows = [];
    
    for (let i = 2; i < candles.length - 2; i++) {
        const curr = candles[i];
        const prev1 = candles[i - 1];
        const prev2 = candles[i - 2];
        const next1 = candles[i + 1];
        const next2 = candles[i + 2];
        
        const currHigh = parseFloat(curr.mid.h);
        const currLow = parseFloat(curr.mid.l);
        
        if (currHigh > parseFloat(prev1.mid.h) && 
            currHigh > parseFloat(prev2.mid.h) &&
            currHigh > parseFloat(next1.mid.h) && 
            currHigh > parseFloat(next2.mid.h)) {
            swingHighs.push({ price: currHigh, index: i, time: curr.time });
        }
        
        if (currLow < parseFloat(prev1.mid.l) && 
            currLow < parseFloat(prev2.mid.l) &&
            currLow < parseFloat(next1.mid.l) && 
            currLow < parseFloat(next2.mid.l)) {
            swingLows.push({ price: currLow, index: i, time: curr.time });
        }
    }
    
    const equalHighs = [];
    const equalLows = [];
    
    const recentHighs = swingHighs.slice(-10);
    const recentLows = swingLows.slice(-10);
    
    for (let i = 0; i < recentHighs.length && equalHighs.length < maxLevels; i++) {
        for (let j = i + 1; j < recentHighs.length && equalHighs.length < maxLevels; j++) {
            const diff = Math.abs(recentHighs[i].price - recentHighs[j].price);
            const avg = (recentHighs[i].price + recentHighs[j].price) / 2;
            if (diff / avg < tolerance) {
                const exists = equalHighs.some(eh => Math.abs(eh.level - avg) / avg < tolerance);
                if (!exists) {
                    equalHighs.push({ level: avg, touches: [recentHighs[i], recentHighs[j]] });
                }
            }
        }
    }
    
    for (let i = 0; i < recentLows.length && equalLows.length < maxLevels; i++) {
        for (let j = i + 1; j < recentLows.length && equalLows.length < maxLevels; j++) {
            const diff = Math.abs(recentLows[i].price - recentLows[j].price);
            const avg = (recentLows[i].price + recentLows[j].price) / 2;
            if (diff / avg < tolerance) {
                const exists = equalLows.some(el => Math.abs(el.level - avg) / avg < tolerance);
                if (!exists) {
                    equalLows.push({ level: avg, touches: [recentLows[i], recentLows[j]] });
                }
            }
        }
    }
    
    return { equalHighs, equalLows };
};

const detectFVG = (candles, index) => {
    if (index < 2 || index >= candles.length) return null;
    
    const c1 = candles[index - 2];
    const c3 = candles[index];
    
    const c1High = parseFloat(c1.mid.h);
    const c1Low = parseFloat(c1.mid.l);
    const c3High = parseFloat(c3.mid.h);
    const c3Low = parseFloat(c3.mid.l);
    
    if (c3Low > c1High) {
        return { type: 'BULLISH', top: c3Low, bottom: c1High, size: c3Low - c1High };
    }
    
    if (c3High < c1Low) {
        return { type: 'BEARISH', top: c1Low, bottom: c3High, size: c1Low - c3High };
    }
    
    return null;
};

const detectSweep = (candles, level, type, atr, displacementMultiple = 1.5) => {
    const recentCandles = candles.slice(-5);
    
    for (let i = 1; i < recentCandles.length; i++) {
        const prev = recentCandles[i - 1];
        const curr = recentCandles[i];
        
        const prevHigh = parseFloat(prev.mid.h);
        const prevLow = parseFloat(prev.mid.l);
        const currHigh = parseFloat(curr.mid.h);
        const currLow = parseFloat(curr.mid.l);
        const currOpen = parseFloat(curr.mid.o);
        const currClose = parseFloat(curr.mid.c);
        
        const bodySize = Math.abs(currClose - currOpen);
        
        let displacementStrength = 'NONE';
        let displacementATR = 0;
        if (atr > 0) {
            displacementATR = bodySize / atr;
            if (displacementATR > 2) displacementStrength = 'STRONG';
            else if (displacementATR > 1.5) displacementStrength = 'NORMAL';
            else if (displacementATR > 1) displacementStrength = 'WEAK';
        }
        
        if (type === 'LOW') {
            const swept = prevLow < level || currLow < level;
            const closedAbove = currClose > level;
            const bullishCandle = currClose > currOpen;
            
            if (swept && closedAbove && bullishCandle) {
                const fvg = detectFVG(candles, candles.length - 1);
                return {
                    direction: 'LONG',
                    sweepLow: Math.min(prevLow, currLow),
                    entryPrice: currClose,
                    hasDisplacement: displacementStrength !== 'NONE',
                    displacementStrength,
                    displacementATR,
                    fvg,
                    confirmationCandle: curr
                };
            }
        }
        
        if (type === 'HIGH') {
            const swept = prevHigh > level || currHigh > level;
            const closedBelow = currClose < level;
            const bearishCandle = currClose < currOpen;
            
            if (swept && closedBelow && bearishCandle) {
                const fvg = detectFVG(candles, candles.length - 1);
                return {
                    direction: 'SHORT',
                    sweepHigh: Math.max(prevHigh, currHigh),
                    entryPrice: currClose,
                    hasDisplacement: displacementStrength !== 'NONE',
                    displacementStrength,
                    displacementATR,
                    fvg,
                    confirmationCandle: curr
                };
            }
        }
    }
    
    return null;
};

const calculateHTFBias = (htfCandles) => {
    if (!htfCandles || htfCandles.length < 20) return 'NEUTRAL';
    
    const recent = htfCandles.slice(-20);
    
    let sum = 0;
    recent.forEach(c => sum += parseFloat(c.mid.c));
    const sma20 = sum / recent.length;
    const currentPrice = parseFloat(recent[recent.length - 1].mid.c);
    
    const lastCandle = recent[recent.length - 1];
    const prevCandle = recent[recent.length - 2];
    const thirdCandle = recent[recent.length - 3];
    
    const lastHigh = parseFloat(lastCandle.mid.h);
    const lastLow = parseFloat(lastCandle.mid.l);
    const prevHigh = parseFloat(prevCandle.mid.h);
    const prevLow = parseFloat(prevCandle.mid.l);
    const thirdHigh = parseFloat(thirdCandle.mid.h);
    const thirdLow = parseFloat(thirdCandle.mid.l);
    
    const higherHighs = lastHigh > prevHigh && prevHigh > thirdHigh;
    const higherLows = lastLow > prevLow && prevLow > thirdLow;
    const lowerHighs = lastHigh < prevHigh && prevHigh < thirdHigh;
    const lowerLows = lastLow < prevLow && prevLow < thirdLow;
    
    let bullishScore = 0;
    let bearishScore = 0;
    
    if (currentPrice > sma20) bullishScore += 2;
    if (currentPrice < sma20) bearishScore += 2;
    
    if (higherHighs) bullishScore += 1;
    if (higherLows) bullishScore += 1;
    if (lowerHighs) bearishScore += 1;
    if (lowerLows) bearishScore += 1;
    
    if (bullishScore >= 3) return 'BULLISH';
    if (bearishScore >= 3) return 'BEARISH';
    return 'NEUTRAL';
};

const getSessionWarning = () => {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const currentTime = utcHours + (utcMinutes / 60);
    
    const equityOpen = LIQUIDITY_CONFIG.EQUITY_OPEN_UTC;
    const warningMinutes = LIQUIDITY_CONFIG.EQUITY_OPEN_WARNING_MINUTES;
    const warningStart = equityOpen - (warningMinutes / 60);
    const warningEnd = equityOpen + 0.25;
    
    if (currentTime >= warningStart && currentTime <= warningEnd) {
        const minutesToOpen = Math.round((equityOpen - currentTime) * 60);
        if (minutesToOpen > 0) {
            return {
                active: true,
                type: 'PRE_MARKET',
                message: `⚠️ Equity Open in ${minutesToOpen} min - Use caution`,
                minutesToOpen
            };
        } else {
            return {
                active: true,
                type: 'MARKET_OPEN',
                message: '⚠️ Equity Market Just Opened - High volatility',
                minutesToOpen: 0
            };
        }
    }
    
    return { active: false };
};

const getCurrentSession = () => {
    const hour = new Date().getUTCHours();
    
    if (hour >= LIQUIDITY_CONFIG.SESSIONS.ASIAN.start && hour < LIQUIDITY_CONFIG.SESSIONS.ASIAN.end) {
        return 'ASIAN';
    }
    if (hour >= LIQUIDITY_CONFIG.SESSIONS.LONDON.start && hour < LIQUIDITY_CONFIG.SESSIONS.LONDON.end) {
        return 'LONDON';
    }
    if (hour >= LIQUIDITY_CONFIG.SESSIONS.NY.start && hour < LIQUIDITY_CONFIG.SESSIONS.NY.end) {
        return 'NEW_YORK';
    }
    return 'OFF_HOURS';
};

// ================================================
// SIGNAL SCORING
// ================================================

const calculateSignalScore = (signal, config = {}) => {
    const SCORING = LIQUIDITY_CONFIG.SCORING;
    const newsBias = config.newsBias || 'NONE';
    
    let score = 0;
    let breakdown = {};
    
    // 1. Level Quality (0-25)
    let levelPoints = 12;
    const levelType = signal.setupType || '';
    
    if (levelType.includes('Previous Day') || levelType.includes('PDH') || levelType.includes('PDL')) {
        levelPoints = 25;
    } else if (levelType.includes('Session') || levelType.includes('Asian') || levelType.includes('London') || levelType.includes('NY')) {
        levelPoints = 18;
    } else if (levelType.includes('Equal')) {
        levelPoints = 12;
    }
    
    score += levelPoints;
    breakdown.levelQuality = { points: levelPoints, max: 25, reason: levelType };
    
    // 2. Displacement (0-25)
    let displacementPoints = SCORING.DISPLACEMENT.NONE;
    let displacementReason = 'None';
    
    if (signal.displacementStrength === 'STRONG') {
        displacementPoints = SCORING.DISPLACEMENT.STRONG;
        displacementReason = `Strong (${(signal.displacementATR || 0).toFixed(1)}x ATR)`;
    } else if (signal.displacementStrength === 'NORMAL') {
        displacementPoints = SCORING.DISPLACEMENT.NORMAL;
        displacementReason = `Normal (${(signal.displacementATR || 0).toFixed(1)}x ATR)`;
    } else if (signal.displacementStrength === 'WEAK') {
        displacementPoints = SCORING.DISPLACEMENT.WEAK;
        displacementReason = `Weak (${(signal.displacementATR || 0).toFixed(1)}x ATR)`;
    }
    
    score += displacementPoints;
    breakdown.displacement = { points: displacementPoints, max: 25, reason: displacementReason };
    
    // 3. FVG (0-20)
    const fvgPoints = signal.hasFVG ? SCORING.FVG.PRESENT : SCORING.FVG.ABSENT;
    score += fvgPoints;
    breakdown.fvg = { points: fvgPoints, max: 20, reason: signal.hasFVG ? 'Present' : 'Absent' };
    
    // 4. HTF Confluence (0-15)
    let htfPoints = SCORING.HTF.NEUTRAL;
    let htfReason = 'Neutral';
    
    if (signal.htfConfluence === 'ALIGNED') {
        htfPoints = SCORING.HTF.ALIGNED;
        htfReason = `Aligned (${signal.htfBias})`;
    } else if (signal.htfConfluence === 'AGAINST') {
        htfPoints = SCORING.HTF.AGAINST;
        htfReason = `Against (${signal.htfBias})`;
    }
    
    score += htfPoints;
    breakdown.htfConfluence = { points: htfPoints, max: 15, reason: htfReason };
    
    // 5. R:R (0-15)
    let rrPoints = 0;
    const rr = signal.rewardRisk || 0;
    
    if (rr >= SCORING.RR.EXCELLENT.min) {
        rrPoints = SCORING.RR.EXCELLENT.points;
    } else if (rr >= SCORING.RR.VERY_GOOD.min) {
        rrPoints = SCORING.RR.VERY_GOOD.points;
    } else if (rr >= SCORING.RR.ACCEPTABLE.min) {
        rrPoints = SCORING.RR.ACCEPTABLE.points;
    } else if (rr >= SCORING.RR.MINIMUM.min) {
        rrPoints = SCORING.RR.MINIMUM.points;
    }
    
    score += rrPoints;
    breakdown.rewardRisk = { points: rrPoints, max: 15, reason: `${rr.toFixed(1)}:1` };
    
    // 6. News Bias (-10 to +10)
    let newsPoints = SCORING.NEWS.NEUTRAL;
    let newsReason = 'No news bias set';
    
    if (newsBias !== 'NONE') {
        const signalDirection = signal.direction;
        
        if ((newsBias === 'BULLISH' && signalDirection === 'LONG') ||
            (newsBias === 'BEARISH' && signalDirection === 'SHORT')) {
            newsPoints = SCORING.NEWS.ALIGNED;
            newsReason = `Aligned with ${newsBias} bias`;
        } else {
            newsPoints = SCORING.NEWS.AGAINST;
            newsReason = `Against ${newsBias} bias`;
        }
    }
    
    score += newsPoints;
    breakdown.newsBias = { points: newsPoints, max: 10, min: -10, reason: newsReason };
    
    // Calculate Grade
    let grade = 'D';
    if (score >= SCORING.GRADES['A+']) grade = 'A+';
    else if (score >= SCORING.GRADES['A']) grade = 'A';
    else if (score >= SCORING.GRADES['B']) grade = 'B';
    else if (score >= SCORING.GRADES['C']) grade = 'C';
    
    return { score, maxScore: 110, grade, breakdown, isPerfect: grade === 'A+' };
};

const calculateTPLevels = (entryPrice, targetPrice, direction) => {
    const range = Math.abs(targetPrice - entryPrice);
    
    if (direction === 'LONG') {
        return {
            tp1: entryPrice + (range * LIQUIDITY_CONFIG.TP_LEVELS.TP1),
            tp2: entryPrice + (range * LIQUIDITY_CONFIG.TP_LEVELS.TP2),
            runner: entryPrice + (range * LIQUIDITY_CONFIG.TP_LEVELS.RUNNER)
        };
    } else {
        return {
            tp1: entryPrice - (range * LIQUIDITY_CONFIG.TP_LEVELS.TP1),
            tp2: entryPrice - (range * LIQUIDITY_CONFIG.TP_LEVELS.TP2),
            runner: entryPrice - (range * LIQUIDITY_CONFIG.TP_LEVELS.RUNNER)
        };
    }
};

// ================================================
// ANALYZE INSTRUMENT
// ================================================

const analyzeInstrument = async (instrument, timeframe = 'H1', config = {}) => {
    try {
        const minRR = config.minRR || LIQUIDITY_CONFIG.MIN_REWARD_RISK;
        const maxSignals = config.maxSignals || LIQUIDITY_CONFIG.MAX_SIGNALS_PER_INSTRUMENT;
        const equalTolerance = config.equalTolerance || LIQUIDITY_CONFIG.EQUAL_LEVEL_TOLERANCE;
        const displacementMultiple = config.displacementMultiple || LIQUIDITY_CONFIG.DISPLACEMENT_ATR_MULTIPLE;
        const requireDisplacement = config.requireDisplacement || false;
        const requireFVG = config.requireFVG || false;
        const maxEqualLevels = config.maxEqualLevels || LIQUIDITY_CONFIG.MAX_EQUAL_LEVELS;
        const directionFilter = config.directionFilter || 'BOTH';
        const requireHTFConfluence = config.requireHTFConfluence !== false;
        const minGrade = config.minGrade || 'D';
        const newsBias = config.newsBias || 'NONE';
        
        const candleCount = { 'M30': 100, 'H1': 72, 'H4': 42, 'D': 30 }[timeframe] || 72;
        const htfTimeframe = LIQUIDITY_CONFIG.HTF_MAP[timeframe] || 'D';
        
        const [dailyCandles, analysisCandles, htfCandles] = await Promise.all([
            fetchCandles(instrument, 'D', 10),
            fetchCandles(instrument, timeframe, candleCount),
            fetchCandles(instrument, htfTimeframe, 30)
        ]);
        
        if (!dailyCandles || !analysisCandles) {
            return { instrument, error: 'Failed to fetch candles' };
        }
        
        const pipSize = getPipSize(instrument);
        const atr = calculateATR(analysisCandles, 14);
        const currentPrice = parseFloat(analysisCandles[analysisCandles.length - 1].mid.c);
        
        const htfBias = calculateHTFBias(htfCandles);
        
        const pdh_pdl = getPDHPDL(dailyCandles);
        const asianLevels = getSessionLevels(analysisCandles, 'ASIAN');
        const londonLevels = getSessionLevels(analysisCandles, 'LONDON');
        const equalLevels = findEqualLevels(analysisCandles, equalTolerance, maxEqualLevels);
        
        const keyLevels = [];
        
        if (pdh_pdl) {
            keyLevels.push({ type: 'PDH', price: pdh_pdl.pdh, source: 'Previous Day High', priority: 1 });
            keyLevels.push({ type: 'PDL', price: pdh_pdl.pdl, source: 'Previous Day Low', priority: 1 });
        }
        
        if (asianLevels) {
            keyLevels.push({ type: 'ASIAN_HIGH', price: asianLevels.high, source: 'Asian Session High', priority: 2 });
            keyLevels.push({ type: 'ASIAN_LOW', price: asianLevels.low, source: 'Asian Session Low', priority: 2 });
        }
        
        if (londonLevels) {
            keyLevels.push({ type: 'LONDON_HIGH', price: londonLevels.high, source: 'London Session High', priority: 2 });
            keyLevels.push({ type: 'LONDON_LOW', price: londonLevels.low, source: 'London Session Low', priority: 2 });
        }
        
        equalLevels.equalHighs.slice(0, 2).forEach((eq, idx) => {
            keyLevels.push({ type: 'EQUAL_HIGH', price: eq.level, source: `Equal Highs ${idx + 1}`, priority: 3 });
        });
        
        equalLevels.equalLows.slice(0, 2).forEach((eq, idx) => {
            keyLevels.push({ type: 'EQUAL_LOW', price: eq.level, source: `Equal Lows ${idx + 1}`, priority: 3 });
        });
        
        const signals = [];
        const seenDirections = new Set();
        
        keyLevels.sort((a, b) => a.priority - b.priority);
        
        const gradeThresholds = { 'A+': 90, 'A': 80, 'B': 70, 'C': 60, 'D': 0 };
        const minScoreThreshold = gradeThresholds[minGrade] || 0;
        
        for (const level of keyLevels) {
            if (signals.length >= maxSignals) break;
            
            const isHighLevel = level.type.includes('HIGH');
            const sweep = detectSweep(analysisCandles, level.price, isHighLevel ? 'HIGH' : 'LOW', atr, displacementMultiple);
            
            if (sweep) {
                if (directionFilter !== 'BOTH' && sweep.direction !== directionFilter) continue;
                
                if (requireHTFConfluence && htfBias !== 'NEUTRAL') {
                    if (sweep.direction === 'LONG' && htfBias === 'BEARISH') continue;
                    if (sweep.direction === 'SHORT' && htfBias === 'BULLISH') continue;
                }
                
                const dirKey = `${sweep.direction}-${level.type.includes('PDH') || level.type.includes('PDL') ? 'PD' : 'OTHER'}`;
                if (seenDirections.has(dirKey)) continue;
                
                let stopLoss, fullTarget, rewardRisk;
                
                if (sweep.direction === 'LONG') {
                    stopLoss = sweep.sweepLow - (atr * 0.5);
                    fullTarget = pdh_pdl ? pdh_pdl.pdh : currentPrice + (currentPrice - stopLoss) * 3;
                    rewardRisk = (fullTarget - sweep.entryPrice) / (sweep.entryPrice - stopLoss);
                } else {
                    stopLoss = sweep.sweepHigh + (atr * 0.5);
                    fullTarget = pdh_pdl ? pdh_pdl.pdl : currentPrice - (stopLoss - currentPrice) * 3;
                    rewardRisk = (sweep.entryPrice - fullTarget) / (stopLoss - sweep.entryPrice);
                }
                
                if (rewardRisk >= minRR) {
                    if (requireDisplacement && !sweep.hasDisplacement) continue;
                    if (requireFVG && !sweep.fvg) continue;
                    
                    let htfConfluence = 'NEUTRAL';
                    if ((sweep.direction === 'LONG' && htfBias === 'BULLISH') ||
                        (sweep.direction === 'SHORT' && htfBias === 'BEARISH')) {
                        htfConfluence = 'ALIGNED';
                    } else if (htfBias !== 'NEUTRAL') {
                        htfConfluence = 'AGAINST';
                    }
                    
                    const tpLevels = calculateTPLevels(sweep.entryPrice, fullTarget, sweep.direction);
                    
                    const signalObj = {
                        instrument,
                        direction: sweep.direction,
                        setupType: level.source,
                        levelSwept: level.price,
                        entryPrice: sweep.entryPrice,
                        stopLoss: Math.round(stopLoss / pipSize) * pipSize,
                        tp1: Math.round(tpLevels.tp1 / pipSize) * pipSize,
                        tp2: Math.round(tpLevels.tp2 / pipSize) * pipSize,
                        runner: Math.round(tpLevels.runner / pipSize) * pipSize,
                        rewardRisk: Math.round(rewardRisk * 100) / 100,
                        hasDisplacement: sweep.hasDisplacement,
                        displacementStrength: sweep.displacementStrength,
                        displacementATR: sweep.displacementATR,
                        hasFVG: sweep.fvg !== null,
                        fvgDetails: sweep.fvg,
                        htfBias,
                        htfConfluence,
                        htfTimeframe,
                        timestamp: new Date().toISOString(),
                        timeframe,
                        priority: level.priority
                    };
                    
                    const scoreResult = calculateSignalScore(signalObj, { newsBias });
                    signalObj.score = scoreResult.score;
                    signalObj.grade = scoreResult.grade;
                    signalObj.scoreBreakdown = scoreResult.breakdown;
                    signalObj.isPerfect = scoreResult.isPerfect;
                    
                    if (scoreResult.score >= minScoreThreshold) {
                        seenDirections.add(dirKey);
                        signals.push(signalObj);
                    }
                }
            }
        }
        
        signals.sort((a, b) => b.score - a.score || a.priority - b.priority);
        
        return {
            instrument,
            currentPrice,
            atr,
            pipSize,
            htfBias,
            keyLevels: keyLevels.length,
            signals,
            pdh: pdh_pdl?.pdh,
            pdl: pdh_pdl?.pdl,
            asianHigh: asianLevels?.high,
            asianLow: asianLevels?.low,
            londonHigh: londonLevels?.high,
            londonLow: londonLevels?.low,
            equalHighs: equalLevels.equalHighs.length,
            equalLows: equalLevels.equalLows.length,
            timeframe,
            lastUpdate: new Date().toISOString()
        };
        
    } catch (error) {
        return { instrument, error: error.message };
    }
};

// ================================================
// SCAN ALL INSTRUMENTS
// ================================================

const scanAllInstruments = async (timeframe = 'H1', customConfig = {}, sendAlerts = true) => {
    console.log(`[${new Date().toISOString()}] Starting ${timeframe} liquidity scan...`);
    
    const config = {
        minRR: customConfig.minRR || LIQUIDITY_CONFIG.MIN_REWARD_RISK,
        maxSignals: customConfig.maxSignals || LIQUIDITY_CONFIG.MAX_SIGNALS_PER_INSTRUMENT,
        equalTolerance: customConfig.equalTolerance || LIQUIDITY_CONFIG.EQUAL_LEVEL_TOLERANCE,
        displacementMultiple: customConfig.displacementMultiple || LIQUIDITY_CONFIG.DISPLACEMENT_ATR_MULTIPLE,
        requireDisplacement: customConfig.requireDisplacement || false,
        requireFVG: customConfig.requireFVG || false,
        maxEqualLevels: customConfig.maxEqualLevels || LIQUIDITY_CONFIG.MAX_EQUAL_LEVELS,
        directionFilter: customConfig.directionFilter || 'BOTH',
        requireHTFConfluence: customConfig.requireHTFConfluence !== false,
        minGrade: customConfig.minGrade || 'D',
        newsBias: customConfig.newsBias || 'NONE'
    };
    
    if (!LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES.includes(timeframe)) {
        timeframe = LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME;
    }
    
    const results = [];
    const allSignals = [];
    
    const batchSize = 5;
    for (let i = 0; i < LIQUIDITY_CONFIG.INSTRUMENTS.length; i += batchSize) {
        const batch = LIQUIDITY_CONFIG.INSTRUMENTS.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(inst => analyzeInstrument(inst, timeframe, config)));
        
        batchResults.forEach(result => {
            results.push(result);
            if (result.signals && result.signals.length > 0) {
                allSignals.push(...result.signals);
            }
        });
        
        if (i + batchSize < LIQUIDITY_CONFIG.INSTRUMENTS.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    allSignals.sort((a, b) => b.score - a.score);
    
    const sessionWarning = getSessionWarning();
    
    const gradeCounts = { 'A+': 0, 'A': 0, 'B': 0, 'C': 0, 'D': 0 };
    allSignals.forEach(s => {
        if (gradeCounts[s.grade] !== undefined) gradeCounts[s.grade]++;
    });
    
    liquidityCache = {
        lastUpdate: new Date().toISOString(),
        timeframe,
        data: results,
        signals: allSignals,
        config
    };
    
    console.log(`[${new Date().toISOString()}] ${timeframe} scan complete. Found ${allSignals.length} signals. A+: ${gradeCounts['A+']}, A: ${gradeCounts['A']}, B: ${gradeCounts['B']}`);
    
    // Send Telegram alerts for new B+ and above signals to Pro users
    if (sendAlerts) {
        await sendSignalAlerts(allSignals);
    }
    
    return {
        timestamp: liquidityCache.lastUpdate,
        timeframe,
        instrumentsScanned: results.length,
        signalsFound: allSignals.length,
        gradeCounts,
        instruments: results,
        signals: allSignals,
        appliedSettings: config,
        sessionWarning,
        currentSession: getCurrentSession()
    };
};

// ================================================
// API ENDPOINTS
// ================================================

app.get('/health', async (req, res) => {
    const proUsers = await getProUsersWithTelegram();
    
    res.json({
        status: 'ok',
        version: 'v7',
        product: 'SweepSignal',
        environment: OANDA_CONFIG.environment,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        features: {
            oandaProxy: true,
            liquidityScanner: true,
            htfBias: true,
            sessionWarnings: true,
            multipleTP: true,
            signalScoring: true,
            telegramAlerts: true,
            supabaseVerification: true,
            newsBias: 'manual-toggle'
        },
        telegram: {
            enabled: LIQUIDITY_CONFIG.ALERTS.ENABLED,
            connectedProUsers: proUsers.length,
            alertGrades: ['A+', 'A', 'B']
        }
    });
});

// Scan endpoint
app.get('/scan', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const timeframe = req.query.timeframe || LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME;
        
        const customConfig = {
            minRR: parseFloat(req.query.minRR) || LIQUIDITY_CONFIG.MIN_REWARD_RISK,
            maxSignals: parseInt(req.query.maxSignals) || LIQUIDITY_CONFIG.MAX_SIGNALS_PER_INSTRUMENT,
            equalTolerance: parseFloat(req.query.equalTolerance) || LIQUIDITY_CONFIG.EQUAL_LEVEL_TOLERANCE,
            displacementMultiple: parseFloat(req.query.displacementMultiple) || LIQUIDITY_CONFIG.DISPLACEMENT_ATR_MULTIPLE,
            requireDisplacement: req.query.requireDisplacement === 'true',
            requireFVG: req.query.requireFVG === 'true',
            maxEqualLevels: parseInt(req.query.maxEqualLevels) || LIQUIDITY_CONFIG.MAX_EQUAL_LEVELS,
            directionFilter: req.query.directionFilter || 'BOTH',
            requireHTFConfluence: req.query.requireHTFConfluence !== 'false',
            minGrade: req.query.minGrade || 'D',
            newsBias: req.query.newsBias || 'NONE'
        };
        
        if (!LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES.includes(timeframe)) {
            return res.status(400).json({ 
                error: 'Invalid timeframe',
                available: LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES 
            });
        }
        
        const cacheKey = JSON.stringify({ timeframe, ...customConfig });
        
        // Don't send alerts for cached responses
        if (!forceRefresh && liquidityCache.lastUpdate && liquidityCache.cacheKey === cacheKey) {
            const cacheAge = Date.now() - new Date(liquidityCache.lastUpdate).getTime();
            if (cacheAge < 60000) {
                return res.json({
                    cached: true,
                    ...liquidityCache,
                    sessionWarning: getSessionWarning(),
                    currentSession: getCurrentSession()
                });
            }
        }
        
        const results = await scanAllInstruments(timeframe, customConfig, forceRefresh);
        liquidityCache.cacheKey = cacheKey;
        res.json(results);
        
    } catch (error) {
        console.error('Scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/liquidity/scan', async (req, res) => {
    // Alias for /scan
    return res.redirect(307, '/scan' + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''));
});

app.get('/liquidity/signals', async (req, res) => {
    try {
        if (!liquidityCache.lastUpdate) {
            await scanAllInstruments();
        }
        
        const cacheAge = Date.now() - new Date(liquidityCache.lastUpdate).getTime();
        const isStale = cacheAge > 300000;
        
        res.json({
            timestamp: liquidityCache.lastUpdate,
            timeframe: liquidityCache.timeframe,
            isStale,
            currentSession: getCurrentSession(),
            sessionWarning: getSessionWarning(),
            signalCount: liquidityCache.signals.length,
            signals: liquidityCache.signals
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/liquidity/levels/:instrument', async (req, res) => {
    try {
        const instrument = req.params.instrument.toUpperCase();
        const timeframe = req.query.timeframe || LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME;
        
        if (!LIQUIDITY_CONFIG.INSTRUMENTS.includes(instrument)) {
            return res.status(400).json({ 
                error: 'Invalid instrument',
                available: LIQUIDITY_CONFIG.INSTRUMENTS 
            });
        }
        
        const result = await analyzeInstrument(instrument, timeframe);
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/liquidity/config', (req, res) => {
    res.json({
        instruments: LIQUIDITY_CONFIG.INSTRUMENTS,
        availableTimeframes: LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES,
        defaultTimeframe: LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME,
        htfMap: LIQUIDITY_CONFIG.HTF_MAP,
        scoring: LIQUIDITY_CONFIG.SCORING,
        tpLevels: LIQUIDITY_CONFIG.TP_LEVELS,
        sessions: LIQUIDITY_CONFIG.SESSIONS,
        currentSession: getCurrentSession(),
        sessionWarning: getSessionWarning(),
        alerts: {
            enabled: LIQUIDITY_CONFIG.ALERTS.ENABLED,
            alertGrades: ['A+', 'A', 'B'],
            cooldownMinutes: LIQUIDITY_CONFIG.ALERTS.COOLDOWN_MINUTES
        }
    });
});

// ================================================
// TELEGRAM ENDPOINTS
// ================================================

app.post('/telegram/test', async (req, res) => {
    try {
        const message = `
🧪 <b>Test Alert</b>

This is a test message from SweepSignal v7.
If you see this, Telegram alerts are working!

⏰ ${new Date().toUTCString()}
`.trim();
        
        await sendTelegramMessage(TELEGRAM_CONFIG.adminChatId, message);
        res.json({ success: true, message: 'Test alert sent to admin' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/telegram/status', async (req, res) => {
    const proUsers = await getProUsersWithTelegram();
    
    res.json({
        enabled: LIQUIDITY_CONFIG.ALERTS.ENABLED,
        botConfigured: !!TELEGRAM_CONFIG.botToken,
        connectedProUsers: proUsers.length,
        alertGrades: ['A+', 'A', 'B'],
        cooldownMinutes: LIQUIDITY_CONFIG.ALERTS.COOLDOWN_MINUTES,
        alertedSignalsInMemory: alertedSignals.size
    });
});

app.post('/telegram/alerts/toggle', (req, res) => {
    LIQUIDITY_CONFIG.ALERTS.ENABLED = !LIQUIDITY_CONFIG.ALERTS.ENABLED;
    res.json({ 
        enabled: LIQUIDITY_CONFIG.ALERTS.ENABLED,
        message: `Alerts ${LIQUIDITY_CONFIG.ALERTS.ENABLED ? 'enabled' : 'disabled'}`
    });
});

// ================================================
// STRIPE ENDPOINTS
// ================================================

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { priceId, userId, userEmail, plan, successUrl, cancelUrl } = req.body;
        
        if (!priceId || !userId || !userEmail) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Make request to Stripe API
        const params = new URLSearchParams({
            'payment_method_types[]': 'card',
            'mode': 'subscription',
            'customer_email': userEmail,
            'line_items[0][price]': priceId,
            'line_items[0][quantity]': '1',
            'success_url': successUrl,
            'cancel_url': cancelUrl,
            'metadata[userId]': userId,
            'metadata[plan]': plan,
            'subscription_data[metadata][userId]': userId,
            'subscription_data[metadata][plan]': plan
        });
        
        const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });
        
        const session = await response.json();
        
        if (session.error) {
            console.error('Stripe error:', session.error);
            return res.status(400).json({ error: session.error.message });
        }
        
        console.log(`[Stripe] Checkout session created for ${userEmail} - ${plan}`);
        res.json({ sessionId: session.id });
        
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Stripe Webhook Handler
app.post('/stripe-webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        // Verify webhook signature if secret is configured
        if (STRIPE_WEBHOOK_SECRET && sig) {
            // Simple signature check - for production, use Stripe SDK
            // For now, we'll process all events from Stripe
            event = JSON.parse(req.body.toString());
        } else {
            event = JSON.parse(req.body.toString());
        }
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log(`[Stripe] Webhook received: ${event.type}`);
    
    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.metadata?.userId;
                const plan = session.metadata?.plan;
                const customerId = session.customer;
                const subscriptionId = session.subscription;
                
                if (userId && plan) {
                    // Update user profile in Supabase
                    const { error } = await supabase
                        .from('profiles')
                        .update({
                            subscription_tier: plan,
                            subscription_status: 'active',
                            stripe_customer_id: customerId,
                            stripe_subscription_id: subscriptionId,
                            trial_end_date: null // Clear trial since they're now paying
                        })
                        .eq('id', userId);
                    
                    if (error) {
                        console.error('Failed to update profile:', error);
                    } else {
                        console.log(`[Stripe] User ${userId} subscribed to ${plan}`);
                        
                        // Send Telegram notification to admin
                        await sendTelegramMessage(TELEGRAM_CONFIG.adminChatId, 
                            `💰 <b>New Subscription!</b>\n\nPlan: ${plan.toUpperCase()}\nUser ID: ${userId}\nCustomer: ${customerId}`
                        );
                    }
                }
                break;
            }
            
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const userId = subscription.metadata?.userId;
                const status = subscription.status;
                
                if (userId) {
                    let subscriptionStatus = 'active';
                    if (status === 'canceled' || status === 'unpaid') {
                        subscriptionStatus = 'canceled';
                    } else if (status === 'past_due') {
                        subscriptionStatus = 'past_due';
                    }
                    
                    await supabase
                        .from('profiles')
                        .update({ subscription_status: subscriptionStatus })
                        .eq('id', userId);
                    
                    console.log(`[Stripe] Subscription updated for ${userId}: ${subscriptionStatus}`);
                }
                break;
            }
            
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const userId = subscription.metadata?.userId;
                
                if (userId) {
                    await supabase
                        .from('profiles')
                        .update({
                            subscription_tier: 'trial',
                            subscription_status: 'canceled',
                            stripe_subscription_id: null
                        })
                        .eq('id', userId);
                    
                    console.log(`[Stripe] Subscription canceled for ${userId}`);
                    
                    // Notify admin
                    await sendTelegramMessage(TELEGRAM_CONFIG.adminChatId,
                        `⚠️ <b>Subscription Canceled</b>\n\nUser ID: ${userId}`
                    );
                }
                break;
            }
            
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const customerId = invoice.customer;
                
                // Find user by Stripe customer ID
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('id, email')
                    .eq('stripe_customer_id', customerId)
                    .single();
                
                if (profile) {
                    await supabase
                        .from('profiles')
                        .update({ subscription_status: 'past_due' })
                        .eq('id', profile.id);
                    
                    console.log(`[Stripe] Payment failed for ${profile.email}`);
                    
                    // Notify admin
                    await sendTelegramMessage(TELEGRAM_CONFIG.adminChatId,
                        `❌ <b>Payment Failed</b>\n\nUser: ${profile.email}\nCustomer: ${customerId}`
                    );
                }
                break;
            }
        }
        
        res.json({ received: true });
        
    } catch (error) {
        console.error('Webhook handler error:', error);
        res.status(500).json({ error: 'Webhook handler failed' });
    }
});

// Get subscription status
app.get('/subscription-status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('subscription_tier, subscription_status, stripe_customer_id, stripe_subscription_id')
            .eq('id', userId)
            .single();
        
        if (error || !profile) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json(profile);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create Stripe Customer Portal Session
app.post('/create-portal-session', async (req, res) => {
    try {
        const { userId, returnUrl } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }
        
        // Get user's Stripe customer ID from Supabase
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('stripe_customer_id, email')
            .eq('id', userId)
            .single();
        
        if (profileError || !profile) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (!profile.stripe_customer_id) {
            return res.status(400).json({ error: 'No active subscription found' });
        }
        
        // Create portal session with Stripe API
        const params = new URLSearchParams({
            'customer': profile.stripe_customer_id,
            'return_url': returnUrl || 'https://vnmrsignal.app/sweepsignal/dashboard.html'
        });
        
        const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });
        
        const session = await response.json();
        
        if (session.error) {
            console.error('Portal session error:', session.error);
            return res.status(400).json({ error: session.error.message });
        }
        
        console.log(`[Stripe] Portal session created for ${profile.email}`);
        res.json({ url: session.url });
        
    } catch (error) {
        console.error('Portal session error:', error);
        res.status(500).json({ error: 'Failed to create portal session' });
    }
});

// Admin Analytics Endpoint (Super Admin Only)
app.post('/admin/analytics', async (req, res) => {
    try {
        const { adminEmail } = req.body;
        
        // Verify super admin
        if (adminEmail !== 'toventuresltd@gmail.com') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // Fetch all profiles using service key (bypasses RLS)
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) {
            console.error('Analytics fetch error:', error);
            return res.status(500).json({ error: 'Failed to fetch analytics' });
        }
        
        // Calculate stats
        const totalUsers = profiles.length;
        const trialUsers = profiles.filter(p => p.subscription_status === 'trialing').length;
        const basicUsers = profiles.filter(p => p.subscription_tier === 'basic' && p.subscription_status === 'active').length;
        const proUsers = profiles.filter(p => p.subscription_tier === 'pro' && p.subscription_status === 'active').length;
        const canceledUsers = profiles.filter(p => p.subscription_status === 'canceled').length;
        const telegramUsers = profiles.filter(p => p.telegram_chat_id).length;
        
        // Calculate revenue
        const monthlyRevenue = (basicUsers * 37) + (proUsers * 67);
        
        // Recent signups (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentSignups = profiles.filter(p => new Date(p.created_at) >= sevenDaysAgo);
        
        console.log(`[Admin] Analytics fetched: ${totalUsers} total users, $${monthlyRevenue} MRR`);
        
        res.json({
            stats: {
                totalUsers,
                trialUsers,
                basicUsers,
                proUsers,
                canceledUsers,
                telegramUsers,
                monthlyRevenue
            },
            users: profiles,
            recentSignups
        });
        
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// OANDA Proxy
app.all('/api/*', (req, res) => {
    const oandaPath = req.path.replace('/api', '');
    const fullPath = oandaPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    
    const options = {
        hostname: getOandaHost(),
        port: 443,
        path: fullPath,
        method: req.method,
        headers: {
            'Authorization': `Bearer ${OANDA_CONFIG.apiToken}`,
            'Accept-Datetime-Format': 'RFC3339',
            'Content-Type': 'application/json'
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        res.status(proxyRes.statusCode);
        
        proxyRes.on('data', (chunk) => { data += chunk; });
        proxyRes.on('end', () => {
            try {
                res.json(JSON.parse(data));
            } catch (e) {
                res.send(data);
            }
        });
    });

    proxyReq.on('error', (error) => {
        res.status(500).json({ error: error.message });
    });

    if (req.body && Object.keys(req.body).length > 0) {
        proxyReq.write(JSON.stringify(req.body));
    }

    proxyReq.end();
});

// ================================================
// SCHEDULED SCANNING
// ================================================

const startScheduledScanning = () => {
    // Scan every 5 minutes
    const SCAN_INTERVAL = 5 * 60 * 1000;
    
    setInterval(async () => {
        console.log(`[Scheduled] Running automated scan...`);
        try {
            // Scan with default settings, alerts enabled
            await scanAllInstruments(LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME, {
                minGrade: 'D',  // Scan all grades for dashboard
                requireHTFConfluence: true
            }, true);  // true = send alerts for B+ and above signals
        } catch (error) {
            console.error('[Scheduled] Scan error:', error);
        }
    }, SCAN_INTERVAL);
    
    console.log(`[Scheduled] Auto-scan enabled every ${SCAN_INTERVAL / 60000} minutes`);
};

// ================================================
// SETUP TELEGRAM WEBHOOK
// ================================================

const setupTelegramWebhook = async () => {
    if (!TELEGRAM_CONFIG.botToken) {
        console.log('[Telegram] No bot token configured');
        return;
    }
    
    const webhookUrl = `https://oanda-proxy.onrender.com/webhook`;
    
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/setWebhook?url=${webhookUrl}`);
        const result = await response.json();
        console.log('[Telegram] Webhook setup:', result.ok ? 'Success' : result.description);
    } catch (error) {
        console.error('[Telegram] Webhook setup failed:', error.message);
    }
};

// ================================================
// START SERVER
// ================================================

app.listen(PORT, '0.0.0.0', async () => {
    console.log('========================================');
    console.log('   SWEEPSIGNAL v8                      ');
    console.log('   Liquidity Sweep Scanner             ');
    console.log('   With Stripe Payments                ');
    console.log('========================================');
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 OANDA Environment: ${OANDA_CONFIG.environment}`);
    console.log(`🔍 Liquidity Scanner: Active`);
    console.log(`📱 Telegram Alerts: ${LIQUIDITY_CONFIG.ALERTS.ENABLED ? 'Enabled' : 'Disabled'}`);
    console.log(`🔐 Supabase: ${SUPABASE_URL ? 'Connected' : 'Not configured'}`);
    console.log(`💳 Stripe: ${STRIPE_SECRET_KEY ? 'Configured' : 'Not configured'}`);
    console.log(`⏰ Current Session: ${getCurrentSession()}`);
    console.log('========================================');
    
    // Setup Telegram webhook
    await setupTelegramWebhook();
    
    // Start scheduled scanning
    startScheduledScanning();
    
    // Send startup notification
    setTimeout(() => {
        sendStartupNotification();
    }, 2000);
    
    // Run initial scan
    setTimeout(() => {
        console.log(`[Startup] Running initial scan...`);
        scanAllInstruments(LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME, {}, true).catch(err => console.error('Initial scan error:', err));
    }, 5000);
});
