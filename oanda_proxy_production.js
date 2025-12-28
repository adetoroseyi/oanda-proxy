const express = require('express');
const cors = require('cors');
const https = require('https');
const fetch = require('node-fetch');

const app = express();

// ================================================
// ORIGINAL OANDA CONFIGURATION (UNCHANGED)
// ================================================
const OANDA_CONFIG = {
    accountId: process.env.OANDA_ACCOUNT_ID || '101-004-37956081-001',
    apiToken: process.env.OANDA_API_TOKEN || '673519b725c06d9e71b1eff404a38d33-81178e52a2898b5c459044dfa5bac1bd',
    environment: process.env.OANDA_ENVIRONMENT || 'practice'
};

const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const getOandaHost = () => {
    return OANDA_CONFIG.environment === 'live' 
        ? 'api-fxtrade.oanda.com'
        : 'api-fxpractice.oanda.com';
};

// ================================================
// ORIGINAL HEALTH CHECK (UNCHANGED)
// ================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        environment: OANDA_CONFIG.environment,
        accountId: OANDA_CONFIG.accountId,
        timestamp: new Date().toISOString()
    });
});

// ================================================
// NEWS API ENDPOINTS (NEW)
// ================================================
const FMP_API_KEY = process.env.FMP_API_KEY;
const RELEVANT_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CHF', 'JPY'];

// Cache
let newsCache = null;
let cacheTime = null;
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

// News events endpoint
app.get('/api/news-events', async (req, res) => {
    try {
        console.log('📰 News events request received');

        // Check cache
        if (newsCache && cacheTime && Date.now() - cacheTime < CACHE_DURATION) {
            console.log('✅ Returning cached news data');
            const nextUpdate = new Date(cacheTime + CACHE_DURATION);
            
            return res.json({ 
                success: true, 
                data: newsCache,
                cached: true,
                cacheAge: Math.round((Date.now() - cacheTime) / 60000),
                nextUpdate: nextUpdate.toISOString(),
                count: newsCache.length
            });
        }

        console.log('🔄 Fetching fresh news data...');

        // Date range
        const today = new Date();
        const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        
        const fromDate = today.toISOString().split('T')[0];
        const toDate = nextWeek.toISOString().split('T')[0];
        
        console.log(`📅 Fetching events from ${fromDate} to ${toDate}`);

        // Fetch from FMP
        const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromDate}&to=${toDate}&apikey=${FMP_API_KEY}`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`FMP API returned status ${response.status}`);
        }
        
        const allEvents = await response.json();
        
        if (!Array.isArray(allEvents)) {
            throw new Error('Invalid response format from FMP API');
        }

        console.log(`📊 Received ${allEvents.length} total events`);

        // Filter for high-impact events
        const highImpactEvents = allEvents.filter(event => {
            if (event.impact !== 'High') return false;
            if (!RELEVANT_CURRENCIES.includes(event.currency)) return false;
            if (!event.date || !event.time) return false;
            return true;
        });

        console.log(`🎯 Filtered to ${highImpactEvents.length} high-impact events`);

        // Clean and sort
        const cleanedEvents = highImpactEvents.map(event => ({
            date: event.date,
            time: event.time,
            currency: event.currency,
            event: event.event,
            impact: event.impact,
            actual: event.actual || null,
            estimate: event.estimate || null,
            previous: event.previous || null,
            country: event.country || null
        }));

        cleanedEvents.sort((a, b) => {
            const dateA = new Date(a.date + ' ' + a.time);
            const dateB = new Date(b.date + ' ' + b.time);
            return dateA - dateB;
        });

        // Update cache
        newsCache = cleanedEvents;
        cacheTime = Date.now();

        console.log('✅ News cache updated');

        res.json({ 
            success: true, 
            data: cleanedEvents,
            cached: false,
            count: cleanedEvents.length,
            fetchedAt: new Date().toISOString(),
            nextUpdate: new Date(Date.now() + CACHE_DURATION).toISOString()
        });

    } catch (error) {
        console.error('❌ News API Error:', error.message);

        // Return stale cache if available
        if (newsCache && newsCache.length > 0) {
            console.log('⚠️ Returning stale cache');
            return res.json({ 
                success: true, 
                data: newsCache,
                cached: true,
                stale: true,
                error: error.message,
                count: newsCache.length
            });
        }

        res.status(500).json({ 
            success: false, 
            error: error.message,
            data: []
        });
    }
});

// News health check
app.get('/api/news-health', (req, res) => {
    res.json({
        status: 'ok',
        hasCache: newsCache !== null,
        cacheAge: cacheTime ? Math.round((Date.now() - cacheTime) / 60000) : null,
        cacheSize: newsCache ? newsCache.length : 0,
        apiKeyConfigured: !!FMP_API_KEY
    });
});

// Force refresh (for testing)
app.post('/api/news-refresh', (req, res) => {
    console.log('🔄 Forcing cache refresh...');
    newsCache = null;
    cacheTime = null;
    res.json({ 
        success: true, 
        message: 'Cache cleared' 
    });
});

// ================================================
// ORIGINAL OANDA PROXY (UNCHANGED)
// ================================================
app.all('/api/*', (req, res) => {
    // Skip if it's a news endpoint (already handled above)
    if (req.path.startsWith('/api/news-')) {
        return; // Already handled by news endpoints
    }

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
    console.log(`✅ Proxy server running on port ${PORT}`);
    console.log(`📊 OANDA Environment: ${OANDA_CONFIG.environment}`);
    console.log(`📰 News API: ${FMP_API_KEY ? 'Configured' : 'Missing'}`);
    console.log('========================================');
    console.log('Available endpoints:');
    console.log('  - GET  /health');
    console.log('  - GET  /api/news-events');
    console.log('  - GET  /api/news-health');
    console.log('  - POST /api/news-refresh');
    console.log('  - ALL  /api/* (OANDA proxy)');
    console.log('========================================');
});
