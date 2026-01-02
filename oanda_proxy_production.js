// ================================================
// OANDA PROXY SERVER - EXTENDED WITH LIQUIDITY SWEEP ANALYSIS
// Combines existing Mean Reversion proxy with new Liquidity Sweep Scanner
// ================================================

const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();

// ================================================
// CONFIGURATION
// ================================================

const OANDA_CONFIG = {
    accountId: process.env.OANDA_ACCOUNT_ID || '101-004-37956081-001',
    apiToken: process.env.OANDA_API_TOKEN || '673519b725c06d9e71b1eff404a38d33-81178e52a2898b5c459044dfa5bac1bd',
    environment: process.env.OANDA_ENVIRONMENT || 'practice'
};

const FMP_API_KEY = process.env.FMP_API_KEY;
const PORT = process.env.PORT || 3001;

// Liquidity Analysis Configuration
const LIQUIDITY_CONFIG = {
    // Instruments to monitor
    INSTRUMENTS: [
        // Majors
        'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF', 'AUD_USD', 'NZD_USD', 'USD_CAD',
        // Crosses
        'EUR_GBP', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'CAD_JPY', 'CHF_JPY',
        'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_NZD',
        'GBP_AUD', 'GBP_CAD', 'GBP_CHF', 'GBP_NZD',
        'AUD_CAD', 'AUD_CHF', 'AUD_NZD', 'NZD_CAD', 'NZD_CHF',
        // Indices & Metals
        'NAS100_USD', 'XAU_USD'
    ],
    
    // Available timeframes for analysis
    AVAILABLE_TIMEFRAMES: ['M30', 'H1', 'H4', 'D'],
    DEFAULT_TIMEFRAME: 'H1',
    
    // Detection thresholds
    EQUAL_LEVEL_TOLERANCE: 0.0003,      // 0.03% for equal highs/lows (tighter)
    DISPLACEMENT_ATR_MULTIPLE: 1.5,     // Candle body > 1.5x ATR = displacement
    MIN_REWARD_RISK: 2.5,               // Minimum R:R to report (increased)
    MAX_EQUAL_LEVELS: 3,                // Max equal highs/lows to track per side
    
    // Timeframes
    DAILY_TIMEFRAME: 'D',               // PDH/PDL calculation
    
    // Session times (hours in UTC)
    SESSIONS: {
        ASIAN:  { start: 0, end: 8 },    // 00:00-08:00 UTC (Asian session)
        LONDON: { start: 7, end: 16 },   // 07:00-16:00 UTC (London session)
        NY:     { start: 13, end: 22 }   // 13:00-22:00 UTC (NY session)
    },
    
    // Signal filtering
    REQUIRE_DISPLACEMENT: false,        // If true, only show signals with displacement
    REQUIRE_FVG: false,                 // If true, only show signals with FVG
    MAX_SIGNALS_PER_INSTRUMENT: 2       // Limit signals per instrument
};

// Cache for analysis results
let liquidityCache = {
    lastUpdate: null,
    data: null,
    signals: []
};

app.use(cors({ origin: '*' }));
app.use(express.json());

// ================================================
// HELPER FUNCTIONS
// ================================================

const getOandaHost = () => {
    return OANDA_CONFIG.environment === 'live' 
        ? 'api-fxtrade.oanda.com'
        : 'api-fxpractice.oanda.com';
};

// Fetch candles from OANDA
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

// Get pip size for instrument
const getPipSize = (instrument) => {
    if (instrument.includes('JPY')) return 0.01;
    if (instrument === 'XAU_USD') return 0.1;
    if (instrument === 'NAS100_USD') return 1;
    return 0.0001;
};

// Calculate ATR
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

// Get previous day high/low
const getPDHPDL = (dailyCandles) => {
    if (dailyCandles.length < 2) return null;
    
    // Previous completed daily candle
    const prevDay = dailyCandles[dailyCandles.length - 2];
    
    return {
        pdh: parseFloat(prevDay.mid.h),
        pdl: parseFloat(prevDay.mid.l),
        date: prevDay.time
    };
};

// Get session high/low
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

// Find equal highs/lows (limited to prevent noise)
const findEqualLevels = (candles, tolerance, maxLevels = 3) => {
    const swingHighs = [];
    const swingLows = [];
    
    // Simple swing detection (local max/min over 3 candles)
    for (let i = 2; i < candles.length - 2; i++) {
        const curr = candles[i];
        const prev1 = candles[i - 1];
        const prev2 = candles[i - 2];
        const next1 = candles[i + 1];
        const next2 = candles[i + 2];
        
        const currHigh = parseFloat(curr.mid.h);
        const currLow = parseFloat(curr.mid.l);
        
        // Check for swing high
        if (currHigh > parseFloat(prev1.mid.h) && 
            currHigh > parseFloat(prev2.mid.h) &&
            currHigh > parseFloat(next1.mid.h) && 
            currHigh > parseFloat(next2.mid.h)) {
            swingHighs.push({ price: currHigh, index: i, time: curr.time });
        }
        
        // Check for swing low
        if (currLow < parseFloat(prev1.mid.l) && 
            currLow < parseFloat(prev2.mid.l) &&
            currLow < parseFloat(next1.mid.l) && 
            currLow < parseFloat(next2.mid.l)) {
            swingLows.push({ price: currLow, index: i, time: curr.time });
        }
    }
    
    // Find equal levels (within tolerance) - only recent ones
    const equalHighs = [];
    const equalLows = [];
    
    // Only check recent swing points (last 10)
    const recentHighs = swingHighs.slice(-10);
    const recentLows = swingLows.slice(-10);
    
    for (let i = 0; i < recentHighs.length && equalHighs.length < maxLevels; i++) {
        for (let j = i + 1; j < recentHighs.length && equalHighs.length < maxLevels; j++) {
            const diff = Math.abs(recentHighs[i].price - recentHighs[j].price);
            const avg = (recentHighs[i].price + recentHighs[j].price) / 2;
            if (diff / avg < tolerance) {
                // Check if we already have a similar level
                const exists = equalHighs.some(eh => Math.abs(eh.level - avg) / avg < tolerance);
                if (!exists) {
                    equalHighs.push({
                        level: avg,
                        touches: [recentHighs[i], recentHighs[j]]
                    });
                }
            }
        }
    }
    
    for (let i = 0; i < recentLows.length && equalLows.length < maxLevels; i++) {
        for (let j = i + 1; j < recentLows.length && equalLows.length < maxLevels; j++) {
            const diff = Math.abs(recentLows[i].price - recentLows[j].price);
            const avg = (recentLows[i].price + recentLows[j].price) / 2;
            if (diff / avg < tolerance) {
                // Check if we already have a similar level
                const exists = equalLows.some(el => Math.abs(el.level - avg) / avg < tolerance);
                if (!exists) {
                    equalLows.push({
                        level: avg,
                        touches: [recentLows[i], recentLows[j]]
                    });
                }
            }
        }
    }
    
    return { equalHighs, equalLows };
};

// Detect Fair Value Gap
const detectFVG = (candles, index) => {
    if (index < 2 || index >= candles.length) return null;
    
    const c1 = candles[index - 2];
    const c2 = candles[index - 1];
    const c3 = candles[index];
    
    const c1High = parseFloat(c1.mid.h);
    const c1Low = parseFloat(c1.mid.l);
    const c3High = parseFloat(c3.mid.h);
    const c3Low = parseFloat(c3.mid.l);
    
    // Bullish FVG: Gap between c1 high and c3 low
    if (c3Low > c1High) {
        return {
            type: 'BULLISH',
            top: c3Low,
            bottom: c1High,
            size: c3Low - c1High
        };
    }
    
    // Bearish FVG: Gap between c1 low and c3 high
    if (c3High < c1Low) {
        return {
            type: 'BEARISH',
            top: c1Low,
            bottom: c3High,
            size: c1Low - c3High
        };
    }
    
    return null;
};

// Detect liquidity sweep
const detectSweep = (candles, level, type, atr, displacementMultiple = 1.5) => {
    // Look at last 5 candles for sweep pattern
    const recentCandles = candles.slice(-5);
    
    for (let i = 1; i < recentCandles.length; i++) {
        const prev = recentCandles[i - 1];
        const curr = recentCandles[i];
        
        const prevHigh = parseFloat(prev.mid.h);
        const prevLow = parseFloat(prev.mid.l);
        const prevClose = parseFloat(prev.mid.c);
        
        const currHigh = parseFloat(curr.mid.h);
        const currLow = parseFloat(curr.mid.l);
        const currOpen = parseFloat(curr.mid.o);
        const currClose = parseFloat(curr.mid.c);
        
        if (type === 'LOW') {
            // Bullish sweep: Price breaks below level, then closes back above
            const swept = prevLow < level || currLow < level;
            const closedAbove = currClose > level;
            const bullishCandle = currClose > currOpen;
            
            // Check for displacement (strong move)
            const bodySize = Math.abs(currClose - currOpen);
            const hasDisplacement = bodySize > (atr * displacementMultiple);
            
            if (swept && closedAbove && bullishCandle) {
                const fvg = detectFVG(candles, candles.length - 1);
                return {
                    direction: 'LONG',
                    sweepLow: Math.min(prevLow, currLow),
                    entryPrice: currClose,
                    hasDisplacement,
                    fvg,
                    confirmationCandle: curr
                };
            }
        }
        
        if (type === 'HIGH') {
            // Bearish sweep: Price breaks above level, then closes back below
            const swept = prevHigh > level || currHigh > level;
            const closedBelow = currClose < level;
            const bearishCandle = currClose < currOpen;
            
            const bodySize = Math.abs(currClose - currOpen);
            const hasDisplacement = bodySize > (atr * displacementMultiple);
            
            if (swept && closedBelow && bearishCandle) {
                const fvg = detectFVG(candles, candles.length - 1);
                return {
                    direction: 'SHORT',
                    sweepHigh: Math.max(prevHigh, currHigh),
                    entryPrice: currClose,
                    hasDisplacement,
                    fvg,
                    confirmationCandle: curr
                };
            }
        }
    }
    
    return null;
};

// Analyze single instrument for liquidity setups
const analyzeInstrument = async (instrument, timeframe = 'H1', config = {}) => {
    try {
        // Use provided config or defaults
        const minRR = config.minRR || LIQUIDITY_CONFIG.MIN_REWARD_RISK;
        const maxSignals = config.maxSignals || LIQUIDITY_CONFIG.MAX_SIGNALS_PER_INSTRUMENT;
        const equalTolerance = config.equalTolerance || LIQUIDITY_CONFIG.EQUAL_LEVEL_TOLERANCE;
        const displacementMultiple = config.displacementMultiple || LIQUIDITY_CONFIG.DISPLACEMENT_ATR_MULTIPLE;
        const requireDisplacement = config.requireDisplacement || false;
        const requireFVG = config.requireFVG || false;
        const maxEqualLevels = config.maxEqualLevels || LIQUIDITY_CONFIG.MAX_EQUAL_LEVELS;
        
        // Determine candle count based on timeframe
        const candleCount = {
            'M30': 100,
            'H1': 72,   // 3 days of hourly
            'H4': 42,   // ~1 week of 4H
            'D': 30     // 1 month of daily
        }[timeframe] || 72;
        
        // Fetch candles for multiple timeframes
        const [dailyCandles, analysisCandles] = await Promise.all([
            fetchCandles(instrument, 'D', 10),
            fetchCandles(instrument, timeframe, candleCount)
        ]);
        
        if (!dailyCandles || !analysisCandles) {
            return { instrument, error: 'Failed to fetch candles' };
        }
        
        const pipSize = getPipSize(instrument);
        const atr = calculateATR(analysisCandles, 14);
        const currentPrice = parseFloat(analysisCandles[analysisCandles.length - 1].mid.c);
        
        // Get key levels
        const pdh_pdl = getPDHPDL(dailyCandles);
        const asianLevels = getSessionLevels(analysisCandles, 'ASIAN');
        const londonLevels = getSessionLevels(analysisCandles, 'LONDON');
        const nyLevels = getSessionLevels(analysisCandles, 'NY');
        const equalLevels = findEqualLevels(
            analysisCandles, 
            equalTolerance,
            maxEqualLevels
        );
        
        // Collect all key levels (prioritize PDH/PDL and session levels)
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
        
        // Only add top equal levels
        equalLevels.equalHighs.slice(0, 2).forEach((eq, idx) => {
            keyLevels.push({ type: 'EQUAL_HIGH', price: eq.level, source: `Equal Highs ${idx + 1}`, priority: 3 });
        });
        
        equalLevels.equalLows.slice(0, 2).forEach((eq, idx) => {
            keyLevels.push({ type: 'EQUAL_LOW', price: eq.level, source: `Equal Lows ${idx + 1}`, priority: 3 });
        });
        
        // Check for sweeps at each level (prioritized)
        const signals = [];
        const seenDirections = new Set(); // Prevent duplicate signals same direction
        
        // Sort by priority
        keyLevels.sort((a, b) => a.priority - b.priority);
        
        for (const level of keyLevels) {
            // Limit signals per instrument
            if (signals.length >= maxSignals) break;
            
            const isHighLevel = level.type.includes('HIGH');
            const sweep = detectSweep(
                analysisCandles, 
                level.price, 
                isHighLevel ? 'HIGH' : 'LOW',
                atr,
                displacementMultiple
            );
            
            if (sweep) {
                // Skip if we already have a signal in this direction
                const dirKey = `${sweep.direction}-${level.type.includes('PDH') || level.type.includes('PDL') ? 'PD' : 'OTHER'}`;
                if (seenDirections.has(dirKey)) continue;
                
                // Calculate SL and TP
                let stopLoss, takeProfit, rewardRisk;
                
                if (sweep.direction === 'LONG') {
                    stopLoss = sweep.sweepLow - (atr * 0.5);
                    // Target opposite side - PDH or nearest high
                    takeProfit = pdh_pdl ? pdh_pdl.pdh : currentPrice + (currentPrice - stopLoss) * 3;
                    rewardRisk = (takeProfit - sweep.entryPrice) / (sweep.entryPrice - stopLoss);
                } else {
                    stopLoss = sweep.sweepHigh + (atr * 0.5);
                    // Target opposite side - PDL or nearest low
                    takeProfit = pdh_pdl ? pdh_pdl.pdl : currentPrice - (stopLoss - currentPrice) * 3;
                    rewardRisk = (sweep.entryPrice - takeProfit) / (stopLoss - sweep.entryPrice);
                }
                
                // Apply configurable filtering
                if (rewardRisk >= minRR) {
                    // Optional: require displacement or FVG
                    if (requireDisplacement && !sweep.hasDisplacement) continue;
                    if (requireFVG && !sweep.fvg) continue;
                    
                    seenDirections.add(dirKey);
                    
                    signals.push({
                        instrument,
                        direction: sweep.direction,
                        setupType: level.source,
                        levelSwept: level.price,
                        entryPrice: sweep.entryPrice,
                        stopLoss: Math.round(stopLoss / pipSize) * pipSize,
                        takeProfit: Math.round(takeProfit / pipSize) * pipSize,
                        rewardRisk: Math.round(rewardRisk * 100) / 100,
                        hasDisplacement: sweep.hasDisplacement,
                        hasFVG: sweep.fvg !== null,
                        fvgDetails: sweep.fvg,
                        timestamp: new Date().toISOString(),
                        timeframe: timeframe,
                        priority: level.priority
                    });
                }
            }
        }
        
        // Sort signals by priority then R:R
        signals.sort((a, b) => a.priority - b.priority || b.rewardRisk - a.rewardRisk);
        
        return {
            instrument,
            currentPrice,
            atr,
            pipSize,
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

// Full market scan
const scanAllInstruments = async (timeframe = 'H1', customConfig = {}) => {
    console.log(`[${new Date().toISOString()}] Starting ${timeframe} liquidity scan...`);
    
    // Merge custom config with defaults
    const config = {
        minRR: customConfig.minRR || LIQUIDITY_CONFIG.MIN_REWARD_RISK,
        maxSignals: customConfig.maxSignals || LIQUIDITY_CONFIG.MAX_SIGNALS_PER_INSTRUMENT,
        equalTolerance: customConfig.equalTolerance || LIQUIDITY_CONFIG.EQUAL_LEVEL_TOLERANCE,
        displacementMultiple: customConfig.displacementMultiple || LIQUIDITY_CONFIG.DISPLACEMENT_ATR_MULTIPLE,
        requireDisplacement: customConfig.requireDisplacement || false,
        requireFVG: customConfig.requireFVG || false,
        maxEqualLevels: customConfig.maxEqualLevels || LIQUIDITY_CONFIG.MAX_EQUAL_LEVELS
    };
    
    // Validate timeframe
    if (!LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES.includes(timeframe)) {
        timeframe = LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME;
    }
    
    const results = [];
    const allSignals = [];
    
    // Process in batches to avoid rate limiting
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
        
        // Small delay between batches
        if (i + batchSize < LIQUIDITY_CONFIG.INSTRUMENTS.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    // Sort signals by priority then R:R descending
    allSignals.sort((a, b) => (a.priority || 99) - (b.priority || 99) || b.rewardRisk - a.rewardRisk);
    
    // Update cache
    liquidityCache = {
        lastUpdate: new Date().toISOString(),
        timeframe,
        data: results,
        signals: allSignals,
        config
    };
    
    console.log(`[${new Date().toISOString()}] ${timeframe} scan complete. Found ${allSignals.length} signals.`);
    
    return {
        timestamp: liquidityCache.lastUpdate,
        timeframe,
        instrumentsScanned: results.length,
        signalsFound: allSignals.length,
        instruments: results,
        signals: allSignals,
        appliedSettings: config
    };
};

// Get current session
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
// EXISTING ENDPOINTS (UNCHANGED)
// ================================================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        environment: OANDA_CONFIG.environment,
        accountId: OANDA_CONFIG.accountId,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        features: {
            oandaProxy: true,
            newsApi: !!FMP_API_KEY,
            liquidityScanner: true
        }
    });
});

// News events endpoint (existing)
app.get('/api/news-events', async (req, res) => {
    if (!FMP_API_KEY) {
        return res.json({ events: [], message: 'News API not configured' });
    }
    
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(
            `https://financialmodelingprep.com/api/v3/economic_calendar?apikey=${FMP_API_KEY}`
        );
        const data = await response.json();
        res.json({ events: data.slice(0, 50) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// News health check (existing)
app.get('/api/news-health', (req, res) => {
    res.json({
        configured: !!FMP_API_KEY,
        timestamp: new Date().toISOString()
    });
});

// ================================================
// NEW LIQUIDITY SWEEP ENDPOINTS
// ================================================

// Full market scan with configurable parameters
app.get('/liquidity/scan', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const timeframe = req.query.timeframe || LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME;
        
        // Parse configurable parameters from query string
        const customConfig = {
            minRR: parseFloat(req.query.minRR) || LIQUIDITY_CONFIG.MIN_REWARD_RISK,
            maxSignals: parseInt(req.query.maxSignals) || LIQUIDITY_CONFIG.MAX_SIGNALS_PER_INSTRUMENT,
            equalTolerance: parseFloat(req.query.equalTolerance) || LIQUIDITY_CONFIG.EQUAL_LEVEL_TOLERANCE,
            displacementMultiple: parseFloat(req.query.displacementMultiple) || LIQUIDITY_CONFIG.DISPLACEMENT_ATR_MULTIPLE,
            requireDisplacement: req.query.requireDisplacement === 'true',
            requireFVG: req.query.requireFVG === 'true',
            maxEqualLevels: parseInt(req.query.maxEqualLevels) || LIQUIDITY_CONFIG.MAX_EQUAL_LEVELS
        };
        
        // Validate timeframe
        if (!LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES.includes(timeframe)) {
            return res.status(400).json({ 
                error: 'Invalid timeframe',
                available: LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES 
            });
        }
        
        // Build cache key based on params
        const cacheKey = `${timeframe}-${customConfig.minRR}-${customConfig.requireDisplacement}-${customConfig.requireFVG}`;
        
        // Return cached if fresh (less than 1 minute old) and same params
        if (!forceRefresh && liquidityCache.lastUpdate && liquidityCache.cacheKey === cacheKey) {
            const cacheAge = Date.now() - new Date(liquidityCache.lastUpdate).getTime();
            if (cacheAge < 60000) {
                return res.json({
                    cached: true,
                    ...liquidityCache
                });
            }
        }
        
        const results = await scanAllInstruments(timeframe, customConfig);
        results.cacheKey = cacheKey;
        results.appliedSettings = customConfig;
        res.json(results);
        
    } catch (error) {
        console.error('Scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get active signals only
app.get('/liquidity/signals', async (req, res) => {
    try {
        const timeframe = req.query.timeframe || liquidityCache.timeframe || LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME;
        
        // If cache is stale or different timeframe, refresh
        if (!liquidityCache.lastUpdate || liquidityCache.timeframe !== timeframe) {
            await scanAllInstruments(timeframe);
        }
        
        const cacheAge = Date.now() - new Date(liquidityCache.lastUpdate).getTime();
        const isStale = cacheAge > 300000; // 5 minutes
        
        res.json({
            timestamp: liquidityCache.lastUpdate,
            timeframe: liquidityCache.timeframe,
            isStale,
            currentSession: getCurrentSession(),
            signalCount: liquidityCache.signals.length,
            signals: liquidityCache.signals
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get levels for specific instrument
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

// Get configuration
app.get('/liquidity/config', (req, res) => {
    res.json({
        instruments: LIQUIDITY_CONFIG.INSTRUMENTS,
        availableTimeframes: LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES,
        defaultTimeframe: LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME,
        thresholds: {
            equalLevelTolerance: LIQUIDITY_CONFIG.EQUAL_LEVEL_TOLERANCE,
            displacementATRMultiple: LIQUIDITY_CONFIG.DISPLACEMENT_ATR_MULTIPLE,
            minRewardRisk: LIQUIDITY_CONFIG.MIN_REWARD_RISK,
            maxSignalsPerInstrument: LIQUIDITY_CONFIG.MAX_SIGNALS_PER_INSTRUMENT
        },
        sessions: LIQUIDITY_CONFIG.SESSIONS,
        currentSession: getCurrentSession()
    });
});

// Force refresh scan
app.post('/liquidity/refresh', async (req, res) => {
    try {
        const timeframe = req.query.timeframe || req.body.timeframe || LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME;
        const results = await scanAllInstruments(timeframe);
        res.json({
            message: 'Scan refreshed',
            ...results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================================================
// OANDA PROXY (EXISTING - UNCHANGED)
// ================================================

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
// START SERVER
// ================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('   OANDA PROXY + LIQUIDITY SCANNER     ');
    console.log('========================================');
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 OANDA Environment: ${OANDA_CONFIG.environment}`);
    console.log(`📰 News API: ${FMP_API_KEY ? 'Configured' : 'Not configured'}`);
    console.log(`🔍 Liquidity Scanner: Active`);
    console.log(`📈 Instruments: ${LIQUIDITY_CONFIG.INSTRUMENTS.length}`);
    console.log(`⏱️  Timeframes: ${LIQUIDITY_CONFIG.AVAILABLE_TIMEFRAMES.join(', ')}`);
    console.log(`⏰ Current Session: ${getCurrentSession()}`);
    console.log('========================================');
    console.log('Endpoints:');
    console.log('  EXISTING:');
    console.log('  - GET  /health');
    console.log('  - GET  /api/news-events');
    console.log('  - ALL  /api/* (OANDA proxy)');
    console.log('  NEW (Liquidity):');
    console.log('  - GET  /liquidity/scan?timeframe=H1');
    console.log('  - GET  /liquidity/signals?timeframe=H1');
    console.log('  - GET  /liquidity/levels/:instrument');
    console.log('  - GET  /liquidity/config');
    console.log('  - POST /liquidity/refresh');
    console.log('========================================');
});

// Initial scan on startup (after 5 second delay)
setTimeout(() => {
    console.log(`[Startup] Running initial ${LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME} liquidity scan...`);
    scanAllInstruments(LIQUIDITY_CONFIG.DEFAULT_TIMEFRAME).catch(err => console.error('Initial scan error:', err));
}, 5000);
