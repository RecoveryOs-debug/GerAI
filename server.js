/**
 * GerAI Backend — Node.js puro, zero dependências
 * Anthropic API integrada no servidor (ANTHROPIC_API_KEY via env var)
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'gerai-dev-secret-' + crypto.randomBytes(8).toString('hex');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'gerai.db.json');

// ─────────────────────────────────────────────
// ANTHROPIC API — server-side call
// ─────────────────────────────────────────────
function callClaude({ system, userMsg, maxTokens = 2000 }) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_KEY) return reject(new Error('ANTHROPIC_API_KEY não configurada no servidor.'));
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Erro Anthropic'));
          resolve(parsed.content?.[0]?.text || '');
        } catch { reject(new Error('Resposta inválida da API')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// SKILLS DOS AGENTES
// ─────────────────────────────────────────────
function getAgentSkill(slug, user, tomOverride) {
  const tom = tomOverride || user?.tom || 'autoridade';
  const nicho = user?.nicho || 'negócios';
  const profissao = user?.profissao || 'criador de conteúdo';
  const publico = user?.publico || 'profissionais';
  const redes = user?.redes || 'Instagram';
  const cores = user?.cores || '#F36B2A, #0F1113';
  const estilo = user?.estilo || 'dark luxury';

  const base = `Você é um especialista em marketing digital e criação de conteúdo para redes sociais.

PERFIL DA MARCA:
- Profissão: ${profissao}
- Nicho: ${nicho}
- Tom de voz: ${tom}
- Público-alvo: ${publico}
- Redes: ${redes}
- Identidade visual: ${estilo}, cores ${cores}

REGRA FUNDAMENTAL: Entregue APENAS o conteúdo final, pronto para copiar e usar. Sem introduções, sem explicações, sem "aqui está o seu...".`;

  const skills = {
    legenda: base + `

SKILL: GERADOR DE LEGENDA PARA REDES SOCIAIS

Crie uma legenda completa e otimizada para engajamento.

ESTRUTURA OBRIGATÓRIA:
━━ GANCHO (1-2 linhas)
Frase que para o scroll nos 3 primeiros palavras. Use: números, contraste, pergunta provocativa ou afirmação polêmica.

━━ DESENVOLVIMENTO (3-5 parágrafos curtos)
Entregue valor real: insight, ensinamento, história ou dado concreto.
Máximo 2 frases por parágrafo. Linha em branco entre parágrafos.

━━ CTA (1 linha)
Chamada para ação específica e direta. Não use "curta e compartilhe".

━━ HASHTAGS
15 hashtags estratégicas: mix de nicho (40%), audiência (40%) e trending (20%).`,

    'roteiro-yt': base + `

SKILL: ROTEIRO COMPLETO PARA YOUTUBE (10-15 minutos)

ESTRUTURA:

[HOOK — 0:00 a 0:30]
Abertura que prende + promessa clara do que o espectador vai ganhar

[INTRODUÇÃO — 0:30 a 1:30]
Apresentação rápida + por que você é a pessoa certa + preview do conteúdo

[BLOCO 1 — 1:30 a 4:00]
Primeiro ponto principal + exemplo real + insight prático
[TEXTO NA TELA] sugerido

[BLOCO 2 — 4:00 a 7:00]
Segundo ponto + dado concreto ou história
[B-ROLL] sugerido

[BLOCO 3 — 7:00 a 10:00]
Terceiro ponto + prova ou resultado mensurável

[VIRADA — 10:00 a 12:00]
O insight mais valioso — o que poucos sabem ou revelam

[CTA — 12:00 ao fim]
Próximo passo claro + inscrição no canal + vídeo relacionado sugerido

Use [CORTE], [B-ROLL], [TEXTO NA TELA], [PAUSA DRAMÁTICA] como marcações.`,

    'roteiro-reels': base + `

SKILL: ROTEIRO PARA REELS DE 60 SEGUNDOS

ESTRUTURA COM TEMPO EXATO:

[0-3s — HOOK VISUAL]
A frase ou ação dos primeiros 3 segundos. Deve gerar curiosidade IMEDIATA ou mostrar o resultado antes do processo.

[3-15s — PROBLEMA / CONTEXTO]
Apresenta a dor ou situação que a audiência reconhece. Ritmo acelerado.

[15-45s — VALOR / SOLUÇÃO]
3 pontos rápidos OU 1 ensinamento central com exemplos.
Linguagem direta. Sem rodeios.

[45-55s — PROVA]
Um dado, número, print ou resultado que valida o conteúdo.

[55-60s — CTA]
"Salva esse vídeo", "Comenta aqui embaixo X", "Segue pra mais sobre isso"

EXTRAS: [TEXTO NA TELA] para cada bloco + [MÚSICA: estilo/ritmo sugerido] + [TRANSIÇÃO] onde aplicável.`,

    story: base + `

SKILL: SEQUÊNCIA DE 7 STORIES COM NARRATIVA PROGRESSIVA

Para cada story especifique:
📍 Texto principal (máximo 3 linhas)
🎬 Tipo de mídia: foto/vídeo/boomerang/só texto
🎯 Sticker: enquete/pergunta/quiz/reação/link
🎪 Objetivo do story

━━━━━━━━━━━━━━━━━━
STORY 1 — ABERTURA
Frase que faz o espectador deslizar para o próximo. Crie suspense ou curiosidade imediata.

STORY 2 — CONTEXTO
Apresenta o problema, situação ou tema central.

STORY 3 — PONTO 1
Primeiro insight ou informação de valor.

STORY 4 — ENGAJAMENTO ATIVO
Enquete ou pergunta que força interação. A resposta importa para o próximo story.

STORY 5 — PONTO 2
Responde ou aprofunda o tema com base no story 4.

STORY 6 — PROVA / RESULTADO
Dado real, screenshot, print ou resultado concreto que valida o conteúdo.

STORY 7 — CTA CLARO
Link, DM, salvar, seguir ou ir para o post. Uma ação só.`,

    linkedin: base + `

SKILL: POST LINKEDIN DE ALTO ALCANCE ORGÂNICO

ESTRUTURA:

LINHA 1 — HOOK (máximo 150 caracteres)
Aparece ANTES do "ver mais". Deve gerar clique obrigatório.
Padrões: número + promessa | afirmação contraintuitiva | pergunta que incomoda | dado surpreendente

CORPO (8-12 linhas)
• Parágrafos de 1-2 frases no máximo
• 1 linha em branco entre parágrafos
• Use dados, experiência pessoal, opinião fundamentada
• Progressão lógica que constrói para o fechamento
• Pode usar listas com bullet points (• ou ▸)

FECHAMENTO
• Insight principal condensado em 1 linha
• Pergunta que gera comentários relevantes (não genérica)
• CTA sutil — nunca peça like explicitamente

REGRAS: Sem excesso de emojis (máximo 3 no post). Tom profissional mas humano. Sem linguagem corporativa vazia.`,

    tiktok: base + `

SKILL: ROTEIRO TIKTOK VIRAL (30-60 segundos)

ESTRUTURA:

[0-2s — HOOK VERBAL]
A PRIMEIRA FRASE falada. Padrões de alta retenção:
"Você não sabe que..." | "Ninguém te conta que..." | "Fiz X por Y dias e..."
| "[número] coisas que [público] não faz..."

[2-10s — SETUP]
Contexto rápido: quem você é e por que importa saber isso.

[10-40s — CONTEÚDO PRINCIPAL]
3 pontos rápidos com exemplos OU 1 história com começo-meio-fim.
Cadência: rápida. Sem pausas longas. Energia alta.

[40-55s — TWIST / PUNCHLINE]
A virada, revelação ou informação que surpreende. O momento "não sabia disso".

[55-60s — CTA]
"Segue pra mais", "Salva isso aqui", "Comenta X se você concorda"

MARCAÇÕES: [TEXTO NA TELA] | [EFEITO sugerido] | [SOM/TREND recomendado] | [CORTE]`
  };

  return skills[slug] || base + '\n\nCrie conteúdo de alta qualidade, específico e pronto para usar.';
}

// SKILL: REFINADOR DE PROMPT
function getRefineSkill(user) {
  const p = user || {};
  return `Você é um especialista em briefing criativo para geração de imagens de marketing.

Transforme qualquer input bruto em um prompt visual otimizado.

PERFIL DA MARCA:
- Nicho: ${p.nicho || 'negócios'}
- Estilo visual: ${p.estilo || 'dark luxury'}
- Cores da marca: ${p.cores || '#F36B2A, #0F1113'}
- Tom: ${p.tom || 'autoridade'}

REGRAS:
1. Responda APENAS com o prompt refinado. Zero explicações.
2. Máximo 3 frases densas e ricas em detalhes visuais.
3. Inclua: sujeito principal, composição, iluminação, mood, paleta de cores da marca.
4. Linguagem técnica de fotografia/design (ex: "dramatic rim lighting", "rule of thirds", "negative space").
5. Sempre termine com: "no text, no watermark, ultra-detailed, ${p.estilo || 'dark luxury'} aesthetic"`;
}

// SKILL: GERADOR DE CONCEITOS VISUAIS
function getConceptsSkill(user) {
  const p = user || {};
  return `Você é um diretor criativo especialista em conteúdo visual para redes sociais.

PERFIL DA MARCA:
- Nicho: ${p.nicho || 'negócios'}
- Estilo: ${p.estilo || 'dark luxury'}
- Cores: ${p.cores || '#F36B2A, #0F1113'}
- Tom: ${p.tom || 'autoridade'}
- Profissão: ${p.profissao || 'criador'}

Gere EXATAMENTE 3 conceitos visuais distintos para o input fornecido.

FORMATO DE RESPOSTA (JSON puro, sem markdown):
[
  {
    "name": "Nome do conceito",
    "approach": "Abordagem visual em 1 frase",
    "emotion": "Emoção que provoca no espectador",
    "prompt": "Prompt completo para geração de imagem"
  },
  { ... },
  { ... }
]

REGRAS:
- Os 3 conceitos devem ser GENUINAMENTE distintos (estilos diferentes)
- Cada prompt deve ter: sujeito, cenário, estilo visual, iluminação, composição, paleta
- Aplicar as cores da marca no prompt
- Terminar cada prompt com "no text, no watermark, ${p.estilo || 'dark luxury'} aesthetic"
- Responda APENAS com o JSON. Nada antes ou depois.`;
}

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
class DB {
  constructor() {
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        console.log('✓ Database loaded from', DB_FILE);
        return parsed;
      }
    } catch(e) { console.error('DB load error:', e.message); }
    return this._default();
  }

  _default() {
    return {
      users: [{
        id: this._id(),
        name: 'Admin GerAI',
        email: 'admin@gerai.com',
        password: this._hashSync('admin123'),
        role: 'admin',
        plan: 'elite',
        quota_limit: 99999,
        quota_used: 0,
        status: 'active',
        created_at: new Date().toISOString()
      }],
      generations: [],
      plans: [
        { id: 'free',  name: 'Free',  price: 0,    quota: 10,  features: ['10 gerações/mês', 'Post e Story', 'Perfil de marca'] },
        { id: 'pro',   name: 'Pro',   price: 4700, quota: 100, features: ['100 gerações/mês', 'Todos os 6 agentes', 'Geração de imagem com IA', 'Histórico ilimitado', 'Perfil de marca completo'] },
        { id: 'elite', name: 'Elite', price: 9700, quota: 500, features: ['500 gerações/mês', 'Tudo do Pro', 'Suporte prioritário', 'API access', 'Múltiplos perfis de marca'] }
      ],
      packages: [
        { id: 'pack50',  name: 'Pacote 50',  price: 1900, quota: 50,  description: '50 gerações avulsas. Sem validade.', active: true },
        { id: 'pack150', name: 'Pacote 150', price: 4900, quota: 150, description: '150 gerações avulsas. Melhor custo-benefício.', active: true }
      ],
      settings: { app_name: 'GerAI', maintenance_mode: false, registration_open: true, default_plan: 'free' }
    };
  }

  save() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2)); } catch(e) { console.error('DB save error:', e.message); }
  }

  _id() { return crypto.randomBytes(12).toString('hex'); }

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

  createUser({ name, email, password, plan = 'free', role = 'user' }) {
    if (this.data.users.find(u => u.email === email)) throw new Error('E-mail já cadastrado');
    const planData = this.data.plans.find(p => p.id === plan) || this.data.plans[0];
    const user = {
      id: this._id(), name, email,
      password: this._hashSync(password),
      role, plan,
      quota_limit: planData.quota,
      quota_used: 0,
      status: 'active',
      created_at: new Date().toISOString()
    };
    this.data.users.push(user);
    this.save();
    return { ...user, password: undefined };
  }

  getUserById(id) {
    const u = this.data.users.find(u => u.id === id);
    if (!u) return null;
    return { ...u, password: undefined };
  }

  getUserByEmail(email) { return this.data.users.find(u => u.email === email); }

  updateUser(id, fields) {
    const idx = this.data.users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error('Usuário não encontrado');
    if (fields.password) fields.password = this._hashSync(fields.password);
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
    if (this.data.users[idx].email === 'admin@gerai.com') throw new Error('Admin master não pode ser excluído');
    this.data.users.splice(idx, 1);
    this.save();
    return true;
  }

  listUsers({ includeAdmin = false, plan, status, search } = {}) {
    let users = this.data.users;
    if (!includeAdmin) users = users.filter(u => u.role !== 'admin' || u.email === 'admin@gerai.com');
    if (plan) users = users.filter(u => u.plan === plan);
    if (status) users = users.filter(u => u.status === status);
    if (search) { const s = search.toLowerCase(); users = users.filter(u => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s)); }
    return users.map(u => ({ ...u, password: undefined }));
  }

  addGeneration(gen) {
    const g = { id: this._id(), ...gen, created_at: new Date().toISOString() };
    this.data.generations.unshift(g);
    if (this.data.generations.length > 2000) this.data.generations = this.data.generations.slice(0, 2000);
    this.save();
    return g;
  }

  getGenerations({ user_id, limit = 50 } = {}) {
    let gens = this.data.generations;
    if (user_id) gens = gens.filter(g => g.user_id === user_id);
    return gens.slice(0, limit);
  }

  getPlans() { return this.data.plans; }

  createPlan(fields) {
    if (!fields.id || !fields.name) throw new Error('id e name obrigatórios');
    if (this.data.plans.find(p => p.id === fields.id)) throw new Error('ID já existe');
    const plan = { price: 0, quota: 10, features: [], ...fields };
    this.data.plans.push(plan);
    this.save();
    return plan;
  }

  deletePlan(id) {
    const idx = this.data.plans.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Plano não encontrado');
    if (['free','pro','elite'].includes(id)) throw new Error('Planos padrão não podem ser excluídos');
    this.data.plans.splice(idx, 1);
    this.save();
    return true;
  }

  getPackages() {
    if (!this.data.packages) this.data.packages = [];
    return this.data.packages;
  }

  createPackage(fields) {
    if (!this.data.packages) this.data.packages = [];
    if (!fields.name) throw new Error('name obrigatório');
    const pkg = { id: 'pack_' + this._id().slice(0,8), price: 0, quota: 50, description: '', active: true, ...fields };
    this.data.packages.push(pkg);
    this.save();
    return pkg;
  }

  updatePackage(id, fields) {
    if (!this.data.packages) this.data.packages = [];
    const idx = this.data.packages.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Pacote não encontrado');
    this.data.packages[idx] = { ...this.data.packages[idx], ...fields };
    this.save();
    return this.data.packages[idx];
  }

  deletePackage(id) {
    if (!this.data.packages) this.data.packages = [];
    const idx = this.data.packages.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Pacote não encontrado');
    this.data.packages.splice(idx, 1);
    this.save();
    return true;
  }

  applyPackage(userId, packageId) {
    if (!this.data.packages) throw new Error('Pacote não encontrado');
    const pkg = this.data.packages.find(p => p.id === packageId);
    if (!pkg) throw new Error('Pacote não encontrado');
    if (!pkg.active) throw new Error('Pacote inativo');
    const user = this.getUserById(userId);
    if (!user) throw new Error('Usuário não encontrado');
    return this.updateUser(userId, { quota_limit: (user.quota_limit || 0) + pkg.quota });
  }

  updatePlan(id, fields) {
    const idx = this.data.plans.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Plano não encontrado');
    this.data.plans[idx] = { ...this.data.plans[idx], ...fields };
    this.save();
    return this.data.plans[idx];
  }

  getSettings() { return this.data.settings; }
  updateSettings(fields) { this.data.settings = { ...this.data.settings, ...fields }; this.save(); return this.data.settings; }

  getStats() {
    const users = this.data.users.filter(u => u.role !== 'admin');
    const breakdown = {};
    this.data.plans.forEach(p => { breakdown[p.id] = users.filter(u => u.plan === p.id).length; });
    const totalRevenue = users.reduce((sum, u) => {
      const plan = this.data.plans.find(p => p.id === u.plan);
      return sum + (plan?.price || 0);
    }, 0);
    return {
      total_users: users.length,
      active_users: users.filter(u => u.status === 'active').length,
      total_generations: this.data.generations.length,
      plan_breakdown: breakdown,
      mrr: totalRevenue
    };
  }

  verifyPassword(email, password) {
    const user = this.getUserByEmail(email);
    if (!user) return null;
    if (!this._verifySync(password, user.password)) return null;
    user.last_login = new Date().toISOString();
    this.save();
    return { ...user, password: undefined };
  }
}

const db = new DB();

// ─────────────────────────────────────────────
// JWT
// ─────────────────────────────────────────────
const JWT = {
  sign(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 30 * 24 * 3600000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  },
  verify(token) {
    try {
      const [header, body, sig] = token.split('.');
      const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
      if (sig !== expected) return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (payload.exp < Date.now()) return null;
      return payload;
    } catch { return null; }
  }
};

// ─────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      try { const raw = Buffer.concat(chunks).toString('utf8').trim(); resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
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
  if (payload.role !== 'admin') { err(res, 'Acesso restrito', 403); return null; }
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

// ── AUTH ──
route('POST', '/api/auth/register', async (req, res) => {
  const { name, email, password } = await parseBody(req);
  if (!name || !email || !password) return err(res, 'Campos obrigatórios: name, email, password');
  if (password.length < 8) return err(res, 'Senha mínima de 8 caracteres');
  try {
    const user = db.createUser({ name, email, password });
    const token = JWT.sign({ id: user.id, email: user.email, role: user.role });
    ok(res, { user, token }, 201);
  } catch(e) { err(res, e.message); }
});

route('POST', '/api/auth/login', async (req, res) => {
  const { email, password } = await parseBody(req);
  if (!email || !password) return err(res, 'E-mail e senha obrigatórios');
  const user = db.verifyPassword(email, password);
  if (!user) return err(res, 'E-mail ou senha incorretos', 401);
  const token = JWT.sign({ id: user.id, email: user.email, role: user.role });
  ok(res, { user, token });
});

route('GET', '/api/auth/me', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const user = db.getUserById(payload.id);
  if (!user) return err(res, 'Usuário não encontrado', 404);
  ok(res, { user });
});

// ── USER ──
route('PUT', '/api/user/profile', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  const allowed = ['name', 'email', 'password', 'profissao', 'nicho', 'publico', 'tom', 'cores', 'estilo', 'redes'];
  const fields = {};
  allowed.forEach(k => { if (body[k] !== undefined) fields[k] = body[k]; });
  try { const user = db.updateUser(payload.id, fields); ok(res, { user }); }
  catch(e) { err(res, e.message); }
});

route('GET', '/api/user/generations', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  ok(res, { generations: db.getGenerations({ user_id: payload.id, limit: 50 }) });
});

// ── GENERATE (conceitos visuais com IA) ──
route('POST', '/api/user/generate', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { format, network, input } = await parseBody(req);
  if (!format || !network || !input) return err(res, 'format, network e input obrigatórios');
  const user = db.getUserById(payload.id);
  if (user.quota_used >= user.quota_limit) return err(res, 'Cota mensal esgotada. Faça upgrade do seu plano.');

  let concepts;
  try {
    const raw = await callClaude({
      system: getConceptsSkill(user),
      userMsg: `Formato: ${format}\nRede: ${network}\nIdeia: "${input}"\n\nGere os 3 conceitos em JSON:`,
      maxTokens: 1500
    });
    // extract JSON
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('JSON inválido');
    concepts = JSON.parse(jsonMatch[0]);
  } catch {
    // fallback template
    concepts = [
      { name: 'O Confronto', approach: `Abordagem direta para "${input.slice(0,40)}..."`, emotion: 'Autoridade + reconhecimento', prompt: `dramatic editorial photography, ${input.slice(0,60)}, deep dark background, ${user?.cores||'#F36B2A'} accent lighting, rule of thirds, no text, no watermark` },
      { name: 'A Virada', approach: `Abordagem conceitual para "${input.slice(0,40)}..."`, emotion: 'Urgência + clareza', prompt: `CGI 3D cinematic render, ${input.slice(0,60)}, dark luxury aesthetic, golden accent, professional composition, no text, no watermark` },
      { name: 'O Resultado', approach: `Abordagem emocional para "${input.slice(0,40)}..."`, emotion: 'Insight + impacto', prompt: `cinematic portrait, ${input.slice(0,60)}, dramatic rim lighting, ${user?.cores||'#F36B2A'} backlight, editorial style, no text, no watermark` }
    ];
  }

  db.updateUser(payload.id, { quota_used: (user.quota_used || 0) + 1 });
  const gen = db.addGeneration({ user_id: payload.id, format, network, concept_name: concepts[0].name, prompt: concepts[0].prompt });
  ok(res, { generation: gen, concepts });
});

// ── REFINE PROMPT (IA real) ──
route('POST', '/api/user/refine-prompt', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { input, format, network } = await parseBody(req);
  if (!input) return err(res, 'input obrigatório');
  const user = db.getUserById(payload.id);
  try {
    const refined = await callClaude({
      system: getRefineSkill(user),
      userMsg: `Input bruto: "${input}"\nFormato: ${format || 'post'}\nRede: ${network || 'instagram'}\n\nGere o prompt refinado:`,
      maxTokens: 300
    });
    ok(res, { refined_prompt: refined.trim(), original: input });
  } catch(e) {
    // fallback: return structured version
    const p = user || {};
    ok(res, { refined_prompt: `${input} | estilo ${p.estilo||'dark luxury'} | cores ${p.cores||'#F36B2A'} | nicho ${p.nicho||'negócios'} | ${format} para ${network}`, original: input });
  }
});

// ── GENERATE CONTENT — AGENTES (IA real) ──
route('POST', '/api/user/generate-content', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { agent, input, tom, tipo, rede } = await parseBody(req);
  if (!agent || !input) return err(res, 'agent e input obrigatórios');
  const user = db.getUserById(payload.id);
  if (user.quota_used >= user.quota_limit) return err(res, 'Cota mensal esgotada');

  try {
    const system = getAgentSkill(agent, user, tom);
    const content = await callClaude({ system, userMsg: input, maxTokens: 2500 });
    db.updateUser(payload.id, { quota_used: (user.quota_used || 0) + 1 });
    db.addGeneration({ user_id: payload.id, format: tipo || agent, network: rede || 'instagram', concept_name: agent, prompt: input.slice(0, 200) });
    ok(res, { content, agent, rede, tipo });
  } catch(e) { err(res, e.message); }
});

// ── ADMIN ──
route('GET', '/api/admin/stats', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  ok(res, { stats: db.getStats() });
});

route('GET', '/api/admin/users', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const url = new URL('http://x' + req.url);
  const users = db.listUsers({
    includeAdmin: url.searchParams.get('all') === 'true',
    plan: url.searchParams.get('plan') || undefined,
    status: url.searchParams.get('status') || undefined,
    search: url.searchParams.get('q') || undefined
  });
  ok(res, { users, total: users.length });
});

route('GET', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const user = db.getUserById(params.id);
  if (!user) return err(res, 'Usuário não encontrado', 404);
  ok(res, { user });
});

route('POST', '/api/admin/users', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const user = db.createUser(body); ok(res, { user }, 201); }
  catch(e) { err(res, e.message); }
});

route('PATCH', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const user = db.updateUser(params.id, body); ok(res, { user }); }
  catch(e) { err(res, e.message); }
});

route('DELETE', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try { db.deleteUser(params.id); ok(res, { message: 'Usuário removido' }); }
  catch(e) { err(res, e.message); }
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
  try { const plan = db.updatePlan(params.id, body); ok(res, { plan }); }
  catch(e) { err(res, e.message); }
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

// ── GENERATE IMAGE SVG (IA real) ──
route('POST', '/api/user/generate-image', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { prompt, format, network } = await parseBody(req);
  if (!prompt) return err(res, 'prompt obrigatório');
  const user = db.getUserById(payload.id);
  if (user.quota_used >= user.quota_limit) return err(res, 'Cota mensal esgotada');

  const system = `Você é diretor de arte especialista em criação de imagens SVG para redes sociais.
REGRAS ABSOLUTAS:
1. Responda APENAS com código SVG puro. Zero texto antes ou depois.
2. Sem markdown, sem blocos de código, sem explicações.
3. Comece com <svg e termine com </svg>
4. Use viewBox="0 0 1080 1080" e xmlns="http://www.w3.org/2000/svg"
5. font-family explícito em todo elemento text: font-family="Arial Black, Arial, sans-serif"
6. dominant-baseline="central" em textos centralizados
7. Fundo escuro. Hierarquia visual: dominante 60%, suporte 25%, accent 5-10%
8. Cores do perfil têm PRIORIDADE ABSOLUTA. Use as cores fornecidas.

PERFIL DA MARCA:
- Cores: ${user.cores || '#F36B2A, #0F1113'}
- Estilo: ${user.estilo || 'dark luxury'}
- Nicho: ${user.nicho || 'negócios'}`;

  try {
    const raw = await callClaude({ system, userMsg: `FORMATO: ${format} para ${network}
CONCEITO: "${prompt}"

Gere o SVG:`, maxTokens: 4000 });
    const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
    if (!match) throw new Error('IA não retornou SVG válido. Tente novamente.');
    db.updateUser(payload.id, { quota_used: (user.quota_used || 0) + 1 });
    ok(res, { svg: match[0] });
  } catch(e) { err(res, e.message); }
});

// ── PUBLIC PLANS + PACKAGES (landing page & user) ──
route('GET', '/api/plans', async (req, res) => {
  ok(res, { plans: db.getPlans(), packages: db.getPackages().filter(p => p.active) });
});

// ── ADMIN: CREATE/DELETE PLANS ──
route('POST', '/api/admin/plans', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const plan = db.createPlan(body); ok(res, { plan }, 201); }
  catch(e) { err(res, e.message); }
});

route('DELETE', '/api/admin/plans/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try { db.deletePlan(params.id); ok(res, { message: 'Plano removido' }); }
  catch(e) { err(res, e.message); }
});

// ── ADMIN: PACKAGES CRUD ──
route('GET', '/api/admin/packages', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  ok(res, { packages: db.getPackages() });
});

route('POST', '/api/admin/packages', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const pkg = db.createPackage(body); ok(res, { package: pkg }, 201); }
  catch(e) { err(res, e.message); }
});

route('PATCH', '/api/admin/packages/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const pkg = db.updatePackage(params.id, body); ok(res, { package: pkg }); }
  catch(e) { err(res, e.message); }
});

route('DELETE', '/api/admin/packages/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try { db.deletePackage(params.id); ok(res, { message: 'Pacote removido' }); }
  catch(e) { err(res, e.message); }
});

// ── USER: APPLY PACKAGE ──
route('POST', '/api/user/apply-package', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { package_id } = await parseBody(req);
  if (!package_id) return err(res, 'package_id obrigatório');
  try {
    const user = db.applyPackage(payload.id, package_id);
    ok(res, { user, message: 'Pacote aplicado! Créditos adicionados.' });
  } catch(e) { err(res, e.message); }
});

// ── STATIC ──
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

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
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
    try { await match.handler(req, res, match.params); }
    catch(e) { console.error('Route error:', e); err(res, 'Erro interno', 500); }
  } else {
    const body = JSON.stringify({ ok: false, error: `Rota não encontrada: ${req.method} ${req.url}` });
    res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  }
});

server.listen(PORT, HOST, () => {
  const hasKey = !!ANTHROPIC_KEY;
  console.log(`
╔════════════════════════════════════════════╗
║         GerAI Backend v2.0.0               ║
╠════════════════════════════════════════════╣
║  Server:   http://localhost:${PORT}          ║
║  Admin UI: http://localhost:${PORT}/admin    ║
║  AI Engine: ${hasKey ? '✓ Anthropic conectada  ' : '✗ ANTHROPIC_API_KEY ausente'}     ║
╠════════════════════════════════════════════╣
║  Admin login:                              ║
║    email:    admin@gerai.com               ║
║    password: admin123                      ║
╚════════════════════════════════════════════╝
${!hasKey ? '\n⚠️  Defina ANTHROPIC_API_KEY no Railway para ativar a IA.\n' : ''}  `);
});
