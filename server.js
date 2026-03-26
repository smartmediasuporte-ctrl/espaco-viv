const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4200;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

// ===== DATA STORE =====
const DEFAULT_DATA = {
  config: {
    cliente: 'Espaco Viv',
    dateStart: '2026-03-11',
    dateEnd: '2026-04-24',
    valor: 3500,
    metaPosts: 20,
    adsBudget: 0
  },
  tasks: [],
  posts: [],
  campaigns: [],
  ads: { budgetTotal: 0, budgetUsed: 0 },
  performance: {},
  dash_metrics: { adsUsed: 0, adsTotal: 0 },
  report: {},
  report_history: [],
  social_posts: []
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
  return { ...DEFAULT_DATA };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let appData = loadData();

// ===== SSE CLIENTS =====
const sseClients = new Map(); // id -> { res, user }
let clientIdCounter = 0;

function broadcast(section, data, fromUser, excludeId) {
  const msg = JSON.stringify({ section, data, user: fromUser, time: Date.now() });
  for (const [id, client] of sseClients) {
    if (id !== excludeId) {
      client.res.write(`data: ${msg}\n\n`);
    }
  }
}

function broadcastUsers() {
  const users = [];
  for (const [id, client] of sseClients) {
    users.push({ id, user: client.user });
  }
  const msg = JSON.stringify({ section: '_users', data: users, time: Date.now() });
  for (const [, client] of sseClients) {
    client.res.write(`data: ${msg}\n\n`);
  }
}

// ===== HTTP SERVER =====
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE endpoint
  if (pathname === '/api/events' && req.method === 'GET') {
    const user = url.searchParams.get('user') || 'Anonimo';
    const clientId = ++clientIdCounter;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ section: '_connected', data: { id: clientId } })}\n\n`);

    sseClients.set(clientId, { res, user });
    broadcastUsers();

    req.on('close', () => {
      sseClients.delete(clientId);
      broadcastUsers();
    });
    return;
  }

  // GET all data
  if (pathname === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(appData));
    return;
  }

  // POST update section
  if (pathname === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { section, data, user, clientId } = JSON.parse(body);
        if (!section || data === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'section and data required' }));
          return;
        }
        appData[section] = data;
        saveData(appData);
        broadcast(section, data, user || 'Sistema', clientId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET online users
  if (pathname === '/api/users' && req.method === 'GET') {
    const users = [];
    for (const [id, client] of sseClients) {
      users.push({ id, user: client.user });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(users));
    return;
  }

  // ===== IMAGE GENERATION PROXY (Stable Horde - free) =====
  if (pathname === '/api/generate-image' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { prompt, width, height } = JSON.parse(body);
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'prompt required' }));
          return;
        }
        // Step 1: Submit to Stable Horde
        const postData = JSON.stringify({
          prompt: prompt.substring(0, 500),
          params: { width: width || 512, height: height || 640, steps: 25, cfg_scale: 7 },
          nsfw: false,
          models: ['AlbedoBase XL (SDXL)'],
          r2: true
        });
        const reqOpts = {
          hostname: 'stablehorde.net',
          path: '/api/v2/generate/async',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': '0000000000', 'Content-Length': Buffer.byteLength(postData) }
        };
        const hReq = https.request(reqOpts, (hRes) => {
          let data = '';
          hRes.on('data', c => data += c);
          hRes.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (!result.id) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to submit', detail: data }));
                return;
              }
              // Step 2: Poll for result
              let attempts = 0;
              const maxAttempts = 60;
              const pollInterval = setInterval(() => {
                attempts++;
                if (attempts > maxAttempts) {
                  clearInterval(pollInterval);
                  res.writeHead(504, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Timeout - try again' }));
                  return;
                }
                https.get(`https://stablehorde.net/api/v2/generate/check/${result.id}`, (checkRes) => {
                  let cData = '';
                  checkRes.on('data', c => cData += c);
                  checkRes.on('end', () => {
                    try {
                      const check = JSON.parse(cData);
                      if (check.done) {
                        clearInterval(pollInterval);
                        // Get the result
                        https.get(`https://stablehorde.net/api/v2/generate/status/${result.id}`, (statusRes) => {
                          let sData = '';
                          statusRes.on('data', c => sData += c);
                          statusRes.on('end', () => {
                            try {
                              const status = JSON.parse(sData);
                              if (status.generations && status.generations.length > 0) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ url: status.generations[0].img, id: result.id }));
                              } else {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'No image generated' }));
                              }
                            } catch (e) {
                              res.writeHead(500, { 'Content-Type': 'application/json' });
                              res.end(JSON.stringify({ error: e.message }));
                            }
                          });
                        });
                      }
                    } catch (e) { /* keep polling */ }
                  });
                });
              }, 3000);
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        });
        hReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        hReq.write(postData);
        hReq.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  let filePath = pathname === '/' ? INDEX_FILE : path.join(__dirname, pathname);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': (mimeTypes[ext] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Espaco Viv server running on http://localhost:${PORT}`);
});
