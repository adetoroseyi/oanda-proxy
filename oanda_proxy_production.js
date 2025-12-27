const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();

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

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        environment: OANDA_CONFIG.environment,
        accountId: OANDA_CONFIG.accountId,
        timestamp: new Date().toISOString()
    });
});

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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Proxy server running on port ${PORT}`);
});