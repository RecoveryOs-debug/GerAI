/**
 * GerAI Backend — Pure Node.js, zero dependencies
 * Auth: JWT (manual HMAC-SHA256) + bcrypt (manual PBKDF2)
 * DB:   SQLite via child_process sqlite3 CLI OR JSON file fallback
 * Run:  node server.js
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'gerai-secret-change-in-prod-' + crypto.randomBytes(16).toString('hex');
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'gerai.db.json');
const HOST = '0.0.0.0'; // Railway requires binding to all interfaces

// ─────────────────────────────────────────────
// SIMPLE JSON DATABASE (no deps needed)
// ─────────────────────────────────────────────
class DB {
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch {}
    return this._defaults();
  }

  _defaults() {
    const adminId = this._id();
    const adminHash = this._hashSync('admin123');
    return {
      users: [
        {
          id: adminId,
          name: 'Admin GerAI',
          email: 'admin@gerai.com',
          password: adminHash,
          role: 'admin',
          plan: 'elite',
          status: 'active',
          quota_used: 0,
          quota_limit: 999999,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_login: null,
          notes: 'Conta administradora principal'
        }
      ],
      generations: [],
      plans: [
        { id: 'free',  name: 'Free',  price: 0,    quota: 10,  features: ['10 gerações/mês', 'Post e Story'] },
        { id: 'pro',   name: 'Pro',   price: 4700, quota: 100, features: ['100 gerações/mês', 'Todos os formatos', 'Histórico ilimitado', 'Nano Banana'] },
        { id: 'elite', name: 'Elite', price: 9700, quota: 500, features: ['500 gerações/mês', 'Tudo do Pro', 'Suporte prioritário', 'API access', 'White-label'] }
      ],
      settings: {
        app_name: 'GerAI',
        maintenance_mode: false,
        registration_open: true,
        default_plan: 'free'
      }
    };
  }

  _id() {
    return crypto.randomBytes(12).toString('hex');
  }

  _hashSync(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  _verifySync(password, stored) {
    const [salt, hash] = stored.split(':');
    const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return check === hash;
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  // ── USERS ──
  getUsers(filters = {}) {
    let users = this.data.users.filter(u => u.role !== 'admin' || filters.includeAdmin);
    if (filters.plan) users = users.filter(u => u.plan === filters.plan);
    if (filters.status) users = users.filter(u => u.status === filters.status);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      users = users.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    }
    return users.map(u => ({ ...u, password: undefined }));
  }

  getUserById(id) {
    const u = this.data.users.find(u => u.id === id);
    if (!u) return null;
    return { ...u, password: undefined };
  }

  getUserByEmail(email) {
    return this.data.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  }

  createUser({ name, email, password, plan = 'free', role = 'user' }) {
    if (this.getUserByEmail(email)) throw new Error('E-mail já cadastrado');
    const planData = this.data.plans.find(p => p.id === plan) || this.data.plans[0];
    const user = {
      id: this._id(),
      name,
      email: email.toLowerCase(),
      password: this._hashSync(password),
      role,
      plan,
      status: 'active',
      quota_used: 0,
      quota_limit: planData.quota,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_login: null,
      notes: ''
    };
    this.data.users.push(user);
    this.save();
    return { ...user, password: undefined };
  }

  updateUser(id, fields) {
    const idx = this.data.users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error('Usuário não encontrado');
    if (fields.password) {
      fields.password = this._hashSync(fields.password);
    }
    if (fields.plan) {
      const planData = this.data.plans.find(p => p.id === fields.plan);
      if (planData) fields.quota_limit = planData.quota;
    }
    this.data.users[idx] = { ...this.data.users[idx], ...fields, updated_at: new Date().toISOString() };
    this.save();
    return { ...this.data.users[idx], password: undefined };
  }

  deleteUser(id) {
    const idx = this.data.users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error('Usuário não encontrado');
    // Only protect the master admin (first admin created, email admin@gerai.com)
    const u = this.data.users[idx];
    if (u.role === 'admin' && u.email === 'admin@gerai.com') throw new Error('O admin master não pode ser excluído');
    this.data.users.splice(idx, 1);
    this.save();
    return true;
  }

  verifyPassword(email, password) {
    const user = this.getUserByEmail(email);
    if (!user) return null;
    if (!this._verifySync(password, user.password)) return null;
    user.last_login = new Date().toISOString();
    this.save();
    return { ...user, password: undefined };
  }

  // ── GENERATIONS ──
  addGeneration({ user_id, format, network, concept_name, prompt }) {
    const user = this.data.users.find(u => u.id === user_id);
    if (!user) throw new Error('Usuário não encontrado');
    if (user.quota_used >= user.quota_limit) throw new Error('Cota mensal esgotada');
    user.quota_used++;
    user.updated_at = new Date().toISOString();
    const gen = {
      id: this._id(),
      user_id,
      format,
      network,
      concept_name,
      prompt,
      created_at: new Date().toISOString()
    };
    this.data.generations.unshift(gen);
    // keep last 10k generations
    if (this.data.generations.length > 10000) this.data.generations = this.data.generations.slice(0, 10000);
    this.save();
    return gen;
  }

  getGenerations(filters = {}) {
    let gens = [...this.data.generations];
    if (filters.user_id) gens = gens.filter(g => g.user_id === filters.user_id);
    if (filters.limit) gens = gens.slice(0, filters.limit);
    return gens;
  }

  // ── STATS ──
  getStats() {
    const users = this.data.users.filter(u => u.role !== 'admin');
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    const thisMonth = this.data.generations.filter(g => {
      const d = new Date(g.created_at);
      return d.getMonth() === month && d.getFullYear() === year;
    });
    return {
      total_users: users.length,
      active_users: users.filter(u => u.status === 'active').length,
      suspended_users: users.filter(u => u.status === 'suspended').length,
      total_generations: this.data.generations.length,
      generations_this_month: thisMonth.length,
      plan_breakdown: {
        free:  users.filter(u => u.plan === 'free').length,
        pro:   users.filter(u => u.plan === 'pro').length,
        elite: users.filter(u => u.plan === 'elite').length
      },
      mrr: users.filter(u => u.status === 'active').reduce((acc, u) => {
        const plan = this.data.plans.find(p => p.id === u.plan);
        return acc + (plan ? plan.price : 0);
      }, 0)
    };
  }

  // ── PLANS ──
  getPlans() { return this.data.plans; }
  updatePlan(id, fields) {
    const idx = this.data.plans.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Plano não encontrado');
    this.data.plans[idx] = { ...this.data.plans[idx], ...fields };
    this.save();
    return this.data.plans[idx];
  }

  // ── SETTINGS ──
  getSettings() { return this.data.settings; }
  updateSettings(fields) {
    this.data.settings = { ...this.data.settings, ...fields };
    this.save();
    return this.data.settings;
  }
}

const db = new DB(DB_FILE);
console.log('✓ Database loaded from', DB_FILE);

// ─────────────────────────────────────────────
// JWT (manual, no deps)
// ─────────────────────────────────────────────
const JWT = {
  sign(payload, expiresIn = 86400) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, iat: now, exp: now + expiresIn };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
  },
  verify(token) {
    const parts = (token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  }
};

// ─────────────────────────────────────────────
// HTTP SERVER + ROUTER
// ─────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  });
  res.end(body);
}

function ok(res, data, status = 200) { send(res, status, { ok: true, ...data }); }
function err(res, message, status = 400) { send(res, status, { ok: false, error: message }); }

function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  return JWT.verify(token);
}

function requireAuth(req, res) {
  const payload = auth(req);
  if (!payload) { err(res, 'Não autorizado', 401); return null; }
  return payload;
}

function requireAdmin(req, res) {
  const payload = requireAuth(req, res);
  if (!payload) return null;
  if (payload.role !== 'admin') { err(res, 'Acesso restrito a administradores', 403); return null; }
  return payload;
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp('^' + pattern.replace(/:[^/]+/g, '([^/]+)') + '$'), raw: pattern, handler });
}

function matchRoute(method, url) {
  const [path] = url.split('?');
  for (const r of routes) {
    if (r.method !== method && r.method !== 'ALL') continue;
    const m = path.match(r.pattern);
    if (m) {
      const keys = (r.raw.match(/:[^/]+/g) || []).map(k => k.slice(1));
      const params = {};
      keys.forEach((k, i) => params[k] = m[i + 1]);
      return { handler: r.handler, params };
    }
  }
  return null;
}

// ── AUTH ROUTES ──
route('POST', '/api/auth/register', async (req, res) => {
  const { name, email, password } = await parseBody(req);
  if (!name || !email || !password) return err(res, 'Campos obrigatórios: name, email, password');
  if (password.length < 8) return err(res, 'Senha mínima de 8 caracteres');
  try {
    const user = db.createUser({ name, email, password });
    const token = JWT.sign({ id: user.id, email: user.email, role: user.role });
    ok(res, { user, token }, 201);
  } catch (e) { err(res, e.message); }
});

route('POST', '/api/auth/login', async (req, res) => {
  const { email, password } = await parseBody(req);
  if (!email || !password) return err(res, 'E-mail e senha obrigatórios');
  const user = db.verifyPassword(email, password);
  if (!user) return err(res, 'Credenciais inválidas', 401);
  if (user.status === 'suspended') return err(res, 'Conta suspensa. Entre em contato com o suporte.', 403);
  const token = JWT.sign({ id: user.id, email: user.email, role: user.role });
  ok(res, { user, token });
});

route('GET', '/api/auth/me', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const user = db.getUserById(payload.id);
  if (!user) return err(res, 'Usuário não encontrado', 404);
  ok(res, { user });
});

// ── USER ROUTES ──
route('GET', '/api/user/profile', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const user = db.getUserById(payload.id);
  ok(res, { user });
});

route('PUT', '/api/user/profile', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  const allowed = ['name', 'password', 'profissao', 'nicho', 'publico', 'tom', 'cores', 'estilo', 'redes'];
  const fields = {};
  allowed.forEach(k => { if (body[k] !== undefined) fields[k] = body[k]; });
  try {
    const user = db.updateUser(payload.id, fields);
    ok(res, { user });
  } catch (e) { err(res, e.message); }
});

route('GET', '/api/user/generations', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const gens = db.getGenerations({ user_id: payload.id, limit: 50 });
  ok(res, { generations: gens });
});

route('POST', '/api/user/generate', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { format, network, input } = await parseBody(req);
  if (!format || !network || !input) return err(res, 'Campos obrigatórios: format, network, input');

  const user = db.getUserById(payload.id);
  if (user.quota_used >= user.quota_limit) return err(res, 'Cota mensal esgotada. Faça upgrade do seu plano.');

  // Generate 3 AI concepts (template engine — connect real AI here)
  const concepts = generateConcepts(input, format, network, user);

  try {
    const gen = db.addGeneration({
      user_id: payload.id,
      format,
      network,
      concept_name: concepts[0].name,
      prompt: concepts[0].prompt
    });
    ok(res, { generation: gen, concepts });
  } catch (e) { err(res, e.message); }
});

// ── ADMIN ROUTES ──
route('GET', '/api/admin/stats', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  ok(res, { stats: db.getStats() });
});

route('GET', '/api/admin/users', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const url = new URL('http://x' + req.url);
  const filters = {
    includeAdmin: url.searchParams.get('all') === 'true',
    plan: url.searchParams.get('plan') || undefined,
    status: url.searchParams.get('status') || undefined,
    search: url.searchParams.get('q') || undefined
  };
  ok(res, { users: db.getUsers(filters) });
});

route('GET', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const user = db.getUserById(params.id);
  if (!user) return err(res, 'Usuário não encontrado', 404);
  const gens = db.getGenerations({ user_id: params.id, limit: 20 });
  ok(res, { user, recent_generations: gens });
});

route('POST', '/api/admin/users', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  if (!body.name || !body.email || !body.password) return err(res, 'name, email e password obrigatórios');
  try {
    const user = db.createUser(body);
    ok(res, { user }, 201);
  } catch (e) { err(res, e.message); }
});

route('PATCH', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try {
    const user = db.updateUser(params.id, body);
    ok(res, { user });
  } catch (e) { err(res, e.message); }
});

route('DELETE', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try {
    db.deleteUser(params.id);
    ok(res, { message: 'Usuário removido' });
  } catch (e) { err(res, e.message); }
});

route('GET', '/api/admin/generations', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const url = new URL('http://x' + req.url);
  const limit = parseInt(url.searchParams.get('limit') || '100');
  ok(res, { generations: db.getGenerations({ limit }) });
});

route('GET', '/api/admin/plans', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  ok(res, { plans: db.getPlans() });
});

route('PATCH', '/api/admin/plans/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try {
    const plan = db.updatePlan(params.id, body);
    ok(res, { plan });
  } catch (e) { err(res, e.message); }
});

route('GET', '/api/admin/settings', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  ok(res, { settings: db.getSettings() });
});

route('PATCH', '/api/admin/settings', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  ok(res, { settings: db.updateSettings(body) });
});

// ── ROTAS EXTRAS (usadas pelo frontend v5) ──
route('POST', '/api/user/refine-prompt', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { input, format, network } = await parseBody(req);
  if (!input) return err(res, 'input obrigatório');
  const user = db.getUserById(payload.id);
  // Refinamento estruturado do prompt com base no perfil
  const cores = user?.cores || '#F36B2A, #0F1113';
  const estilo = user?.estilo || 'dark luxury';
  const nicho = user?.nicho || 'negócios';
  const tom = user?.tom || 'autoridade';
  const refined = `${input.trim()} | Estilo: ${estilo} | Cores: ${cores} | Nicho: ${nicho} | Tom: ${tom} | Formato: ${format || 'post'} para ${network || 'instagram'}`;
  ok(res, { refined_prompt: refined, original: input });
});

route('POST', '/api/user/generate-content', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { agent, input, tom, tipo, rede } = await parseBody(req);
  if (!agent || !input) return err(res, 'agent e input obrigatórios');
  const user = db.getUserById(payload.id);
  if (user.quota_used >= user.quota_limit) return err(res, 'Cota mensal esgotada');
  // Incrementa quota
  db.updateUser(payload.id, { quota_used: (user.quota_used || 0) + 1 });
  const tomFinal = tom || user?.tom || 'autoridade';
  const perfil = `Profissão: ${user?.profissao || '—'} | Nicho: ${user?.nicho || '—'} | Tom: ${tomFinal} | Público: ${user?.publico || '—'}`;
  // Retorna o briefing estruturado para o agente processar
  const content = `[AGENTE: ${agent.toUpperCase()}]
[PERFIL: ${perfil}]
[TOM: ${tomFinal}]
[REDE: ${rede}]

INPUT: ${input}

Processe este conteúdo seguindo as melhores práticas para ${rede} com tom ${tomFinal}.`;
  ok(res, { content, agent, rede, tipo });
});

// ── STATIC FILES ──
route('GET', '/admin', async (req, res) => {
  const file = path.join(__dirname, 'admin.html');
  if (!fs.existsSync(file)) return err(res, 'admin.html not found', 404);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(file).pipe(res);
});

route('GET', '/', async (req, res) => {
  const file = path.join(__dirname, 'gerai-v3.html');
  if (!fs.existsSync(file)) { ok(res, { status: 'GerAI API running', version: '1.0.0' }); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(file).pipe(res);
});

// ── CONCEPT GENERATOR (template — swap for real AI) ──
function generateConcepts(input, format, network, user) {
  const style = user?.estilo || 'dark luxury';
  const cores = user?.cores || '#F36B2A, #0F1113';
  const nicho = user?.nicho || 'negócios';

  const styles = ['editorial photography', 'CGI 3D fotorrealista', 'cinematic portrait'];
  const emotions = ['Autoridade + reconhecimento', 'Urgência + clareza', 'Insight + impacto'];
  const names = ['O Confronto', 'A Virada', 'O Resultado'];

  return names.map((name, i) => ({
    name,
    approach: `Abordagem ${['direta', 'conceitual', 'emocional'][i]} para "${input.slice(0, 40)}..."`,
    emotion: emotions[i],
    prompt: `${styles[i]} style, ${input.slice(0, 60)}, color palette ${cores}, ${style} aesthetic, professional composition, high contrast lighting, no text, no watermark, ultra-detailed, cinematic quality, ${network} format optimized`
  }));
}

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    });
    return res.end();
  }

  const match = matchRoute(req.method, req.url);
  if (match) {
    try {
      await match.handler(req, res, match.params);
    } catch (e) {
      console.error('Route error:', e);
      err(res, 'Erro interno do servidor', 500);
    }
  } else {
    // Garantir que resposta de 404 é sempre JSON, nunca HTML
    const body = JSON.stringify({ ok: false, error: `Rota não encontrada: ${req.method} ${req.url}` });
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════╗
║        GerAI Backend v1.0.0            ║
╠════════════════════════════════════════╣
║  Server:   http://localhost:${PORT}       ║
║  Admin UI: http://localhost:${PORT}/admin ║
║  DB file:  gerai.db.json               ║
╠════════════════════════════════════════╣
║  Admin login:                          ║
║    email:    admin@gerai.com           ║
║    password: admin123                  ║
╚════════════════════════════════════════╝
  `);
});
