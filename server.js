// ============================================
// SWEEPSIGNAL TELEGRAM BOT v2.0
// With Supabase User Verification
// ============================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PROXY_URL = process.env.PROXY_URL || 'https://oanda-proxy.onrender.com';
const SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Supabase Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service key for server-side

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Track sent signals to avoid duplicates
const sentSignals = new Map();
const SIGNAL_COOLDOWN = 60 * 60 * 1000; // 1 hour

// ============================================
// TELEGRAM HELPERS
// ============================================
async function sendTelegram(chatId, text, options = {}) {
    try {
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                ...options
            })
        });
        return await response.json();
    } catch (error) {
        console.error('Telegram send error:', error);
        return null;
    }
}

async function sendToAdmin(text) {
    if (ADMIN_CHAT_ID) {
        return sendTelegram(ADMIN_CHAT_ID, text);
    }
}

// ============================================
// USER VERIFICATION
// ============================================
async function verifyCode(code, chatId) {
    try {
        // Find the verification code
        const { data: verification, error: findError } = await supabase
            .from('telegram_verifications')
            .select('*, profiles(*)')
            .eq('code', code)
            .eq('used', false)
            .gt('expires_at', new Date().toISOString())
            .single();
        
        if (findError || !verification) {
            return { success: false, message: 'Invalid or expired code. Please generate a new one from the dashboard.' };
        }
        
        // Check if user is Pro
        if (verification.profiles.subscription_tier !== 'pro' || 
            verification.profiles.subscription_status !== 'active') {
            return { success: false, message: 'Telegram alerts are only available for Pro subscribers.' };
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
            return { success: false, message: 'Error connecting your account. Please try again.' };
        }
        
        return { 
            success: true, 
            message: `✅ Successfully connected!\n\nYou'll now receive real-time alerts for B+ and above signals.\n\nWelcome, ${verification.profiles.full_name || verification.profiles.email}!`
        };
        
    } catch (error) {
        console.error('Verification error:', error);
        return { success: false, message: 'An error occurred. Please try again.' };
    }
}

async function getProUsers() {
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
        console.error('Error in getProUsers:', error);
        return [];
    }
}

// ============================================
// WEBHOOK HANDLER
// ============================================
app.post('/webhook', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.sendStatus(200);
        
        const chatId = message.chat.id;
        const text = message.text || '';
        const username = message.from.username || message.from.first_name || 'User';
        
        // Handle /start command
        if (text === '/start') {
            await sendTelegram(chatId, 
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
                await sendTelegram(chatId, 
                    `❌ <b>Invalid format</b>\n\n` +
                    `Please use: <code>/connect CODE</code>\n\n` +
                    `Get your 6-digit code from the SweepSignal dashboard.`
                );
            } else {
                const code = parts[1];
                const result = await verifyCode(code, chatId);
                await sendTelegram(chatId, result.message);
                
                if (result.success) {
                    await sendToAdmin(`🔗 New Telegram connection:\nUser: ${username}\nChat ID: ${chatId}`);
                }
            }
        }
        // Handle /status command
        else if (text === '/status') {
            const { data: profile } = await supabase
                .from('profiles')
                .select('email, subscription_tier, subscription_status')
                .eq('telegram_chat_id', chatId.toString())
                .single();
            
            if (profile) {
                await sendTelegram(chatId,
                    `✅ <b>Connected</b>\n\n` +
                    `Email: ${profile.email}\n` +
                    `Tier: ${profile.subscription_tier.toUpperCase()}\n` +
                    `Status: ${profile.subscription_status}\n\n` +
                    `You're receiving alerts for B+ and above signals.`
                );
            } else {
                await sendTelegram(chatId,
                    `❌ <b>Not Connected</b>\n\n` +
                    `Your Telegram is not linked to a SweepSignal account.\n\n` +
                    `Use /connect CODE with your code from the dashboard.`
                );
            }
        }
        // Handle /help command
        else if (text === '/help') {
            await sendTelegram(chatId,
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
                `4. Receive real-time B+ signals!\n\n` +
                `Questions? Contact toventuresltd@gmail.com`
            );
        }
        // Unknown command
        else if (text.startsWith('/')) {
            await sendTelegram(chatId, `Unknown command. Type /help for available commands.`);
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(200);
    }
});

// ============================================
// SIGNAL SCANNING & ALERTING
// ============================================
async function scanAndAlert() {
    try {
        console.log(`[${new Date().toISOString()}] Scanning for signals...`);
        
        // Get Pro users with Telegram connected
        const proUsers = await getProUsers();
        
        if (proUsers.length === 0) {
            console.log('No Pro users with Telegram connected.');
            return;
        }
        
        // Fetch signals from proxy
        const response = await fetch(`${PROXY_URL}/scan?minGrade=B&timeframe=H1`);
        if (!response.ok) {
            console.error('Failed to fetch signals');
            return;
        }
        
        const data = await response.json();
        const signals = data.signals || [];
        
        console.log(`Found ${signals.length} signals (B+ or above)`);
        
        // Filter for A+ and A signals only (high quality)
        const qualitySignals = signals.filter(s => s.grade === 'A+' || s.grade === 'A');
        
        for (const signal of qualitySignals) {
            const signalKey = `${signal.instrument}_${signal.direction}_${signal.setupType}`;
            const lastSent = sentSignals.get(signalKey);
            
            // Check cooldown
            if (lastSent && Date.now() - lastSent < SIGNAL_COOLDOWN) {
                console.log(`Skipping ${signalKey} - cooldown active`);
                continue;
            }
            
            // Format alert message
            const alertMessage = formatSignalAlert(signal);
            
            // Send to all Pro users
            let sentCount = 0;
            for (const user of proUsers) {
                try {
                    await sendTelegram(user.telegram_chat_id, alertMessage);
                    sentCount++;
                    // Small delay to avoid rate limits
                    await new Promise(r => setTimeout(r, 100));
                } catch (e) {
                    console.error(`Failed to send to ${user.email}:`, e);
                }
            }
            
            console.log(`Sent ${signalKey} to ${sentCount} Pro users`);
            sentSignals.set(signalKey, Date.now());
            
            // Also send to admin
            await sendToAdmin(`📤 Alert sent to ${sentCount} users:\n${signal.instrument} ${signal.direction} (${signal.grade})`);
        }
        
    } catch (error) {
        console.error('Scan error:', error);
    }
}

function formatSignalAlert(signal) {
    const directionEmoji = signal.direction === 'LONG' ? '🟢' : '🔴';
    const gradeEmoji = signal.grade === 'A+' ? '⭐' : '✨';
    
    return `${gradeEmoji} <b>SWEEPSIGNAL ALERT</b> ${gradeEmoji}

<b>${signal.instrument}</b> ${directionEmoji} <b>${signal.direction}</b>
Grade: <b>${signal.grade}</b> (Score: ${signal.score}/100)

📍 Setup: ${signal.setupType}
📊 HTF Bias: ${signal.htfBias || 'N/A'}

━━━━━━━━━━━━━━━━━━
<b>TRADE LEVELS</b>
━━━━━━━━━━━━━━━━━━
▫️ Entry: <code>${signal.entryPrice}</code>
🛑 Stop Loss: <code>${signal.stopLoss}</code>
🎯 TP1 (50%): <code>${signal.tp1}</code>
🎯 TP2 (75%): <code>${signal.tp2}</code>
🏆 Runner: <code>${signal.runner}</code>
📈 R:R Ratio: <b>${signal.rewardRisk}:1</b>
━━━━━━━━━━━━━━━━━━

${signal.displacementStrength === 'STRONG' ? '⚡ STRONG' : '💫 MODERATE'} | ${signal.hasFVG ? '📊 FVG' : ''} | ${signal.htfBias || ''}

<i>Manage your risk. Not financial advice.</i>`;
}

// ============================================
// HEALTH & SETUP
// ============================================
app.get('/', (req, res) => {
    res.json({ 
        status: 'SweepSignal Bot v2.0 Running',
        features: ['User verification', 'Pro-only alerts', 'Supabase integration'],
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Manual scan trigger (admin only)
app.get('/trigger-scan', async (req, res) => {
    await scanAndAlert();
    res.json({ status: 'Scan triggered' });
});

// Get connected users count (for monitoring)
app.get('/stats', async (req, res) => {
    const proUsers = await getProUsers();
    res.json({ 
        connectedProUsers: proUsers.length,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`SweepSignal Bot v2.0 running on port ${PORT}`);
    
    // Set up webhook
    if (BOT_TOKEN) {
        try {
            const webhookUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://oanda-proxy.onrender.com'}/webhook`;;
            const response = await fetch(`${TELEGRAM_API}/setWebhook?url=${webhookUrl}`);
            const result = await response.json();
            console.log('Webhook setup:', result);
        } catch (e) {
            console.error('Webhook setup failed:', e);
        }
    }
    
    // Send startup notification to admin
    await sendToAdmin('🤖 SweepSignal Bot v2.0 started!\n\nFeatures:\n✅ User verification\n✅ Pro-only alerts\n✅ Supabase integration');
    
    // Start scanning interval
    setInterval(scanAndAlert, SCAN_INTERVAL);
    
    // Initial scan after 30 seconds
    setTimeout(scanAndAlert, 30000);
});

