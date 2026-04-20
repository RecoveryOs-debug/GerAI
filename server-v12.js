/**
 * AutoPostt Backend — server-v13.js
 *
 * Melhorias sobre v12:
 * 1. SQLite via node:sqlite (built-in Node 22) — zero deps, escala para 10k+ users
 * 2. SSE Streaming nos agentes de conteúdo — UX de digitação em tempo real
 * 3. API de Calendário Editorial — CRUD completo de posts agendados
 * 4. Onboarding otimizado — salva step-by-step, progresso não se perde
 *
 * Design Agent v2 (overhaul de qualidade — nível agência):
 * 5. STYLE_DNA rico — 20 templates com DNA completo (cores, fontes, efeitos, regras)
 * 6. Stage 1 (Brief Analyst) — framework de copywriting viral com 6 padrões de gancho
 * 7. Stage 2 (Art Director) — blueprint com layers[], effects, tipografia scale
 * 8. Stage 3 (SVG Executor) — biblioteca de 10 técnicas SVG avançadas, 7 camadas
 *    obrigatórias, receitas por mood, regras anti-falha, maxTokens 10k→12k
 *
 * Fixes:
 * 9. Rastreamento de custo por geração (callClaudeMessages retorna tokens)
 * 10. SVG regex greedy (evita truncamento em SVGs com nested elements)
 * 11. Keepalive SSE a cada 8s (evita timeout de proxies em gerações longas)
 *
 * Compatibilidade total com v12: todos os endpoints existentes preservados.
 * Novos endpoints prefixados claramente abaixo.
 */

const originalEmit = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  if (typeof warning === 'string' && warning.includes('SQLite is an experimental')) return;
  originalEmit(warning, ...args);
};

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT           = process.env.PORT || 3001;
const HOST           = '0.0.0.0';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const DB_PATH        = process.env.DB_PATH || path.join(__dirname, 'autopostt.db');
const LEGACY_JSON    = process.env.LEGACY_JSON || path.join(__dirname, 'gerai.db.json');
// Em produção, defina ALLOWED_ORIGIN=https://seudominio.com no Railway
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || 'pedro@ainoz.com.br';

// ── JWT_SECRET: persiste entre restarts para não invalidar sessões ──
const JWT_SECRET_FILE = path.join(__dirname, '.jwt_secret');
let JWT_SECRET;
if (process.env.JWT_SECRET) {
  JWT_SECRET = process.env.JWT_SECRET;
} else {
  try {
    JWT_SECRET = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
  } catch {
    JWT_SECRET = 'autopostt-' + crypto.randomBytes(24).toString('hex');
    try { fs.writeFileSync(JWT_SECRET_FILE, JWT_SECRET, { mode: 0o600 }); }
    catch (e) { console.warn('[WARN] Não foi possível persistir JWT_SECRET:', e.message); }
  }
}

// ── Logger com timestamp ──
const log = {
  info:  (...a) => console.log(`[${new Date().toISOString()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...a),
};

// ─────────────────────────────────────────────
// SQLITE DATABASE LAYER
// ─────────────────────────────────────────────

class Database {
  constructor() {
    this.db = new DatabaseSync(DB_PATH);
    this._init();
    this._migrate();
  }

  _init() {
    this.db.exec(`PRAGMA journal_mode=WAL`);
    this.db.exec(`PRAGMA foreign_keys=ON`);
    this.db.exec(`PRAGMA busy_timeout=5000`);

    // Users
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        email       TEXT UNIQUE NOT NULL,
        password    TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'user',
        plan        TEXT NOT NULL DEFAULT 'free',
        quota_used  INTEGER NOT NULL DEFAULT 0,
        quota_limit INTEGER NOT NULL DEFAULT 10,
        status      TEXT NOT NULL DEFAULT 'active',
        profissao   TEXT DEFAULT '',
        nicho       TEXT DEFAULT '',
        publico     TEXT DEFAULT '',
        tom         TEXT DEFAULT '',
        cores       TEXT DEFAULT '#F5C518, #0D0D0F',
        estilo      TEXT DEFAULT 'dark luxury',
        redes       TEXT DEFAULT 'Instagram',
        onboard_step INTEGER DEFAULT 0,
        last_login  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Generations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        feature       TEXT,
        format        TEXT,
        network       TEXT,
        concept_name  TEXT,
        prompt        TEXT,
        svg_data      TEXT,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens  INTEGER DEFAULT 0,
        cost_usd      REAL DEFAULT 0,
        credits_used  INTEGER DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_gen_user ON generations(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at DESC)`);

    // Plans
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL,
        price    REAL DEFAULT 0,
        quota    INTEGER DEFAULT 10,
        features TEXT DEFAULT '[]'
      )
    `);

    // Packages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS packages (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        price       REAL DEFAULT 0,
        quota       INTEGER DEFAULT 50,
        description TEXT DEFAULT '',
        active      INTEGER DEFAULT 1
      )
    `);

    // Settings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // === CALENDAR TABLE (novo bloco 3) ===
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_posts (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        content     TEXT DEFAULT '',
        format      TEXT DEFAULT 'post',
        network     TEXT DEFAULT 'instagram',
        status      TEXT NOT NULL DEFAULT 'idea',
        scheduled_at TEXT,
        color       TEXT DEFAULT '#F5C518',
        agent_slug  TEXT DEFAULT '',
        generation_id TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_user ON calendar_posts(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_sched ON calendar_posts(scheduled_at)`);

    // AGENT MEMORY
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_memory (
      user_id TEXT PRIMARY KEY,
      summary TEXT DEFAULT '',
      preferences TEXT DEFAULT '{}',
      negative TEXT DEFAULT '[]',
      positive TEXT DEFAULT '[]',
      gen_count INTEGER DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // GENERATION FEEDBACK
    this.db.exec(`CREATE TABLE IF NOT EXISTS generation_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // SAVED DESIGNS — designs favoritos salvos pelo usuário
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS saved_designs (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        svg        TEXT NOT NULL,
        prompt     TEXT DEFAULT '',
        format     TEXT DEFAULT 'post',
        network    TEXT DEFAULT 'instagram',
        voice_id   TEXT DEFAULT '',
        voice_name TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_designs(user_id)`);

    // LOGIN RATE LIMITING (persistido — sobrevive a restarts)
    this.db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
      identifier TEXT PRIMARY KEY,
      count      INTEGER NOT NULL DEFAULT 0,
      first_at   INTEGER NOT NULL
    )`);

    // Seed default plans if empty
    const planCount = this.db.prepare('SELECT COUNT(*) as c FROM plans').get();
    if (planCount.c === 0) {
      const ins = this.db.prepare(`INSERT OR IGNORE INTO plans VALUES (?,?,?,?,?)`);
      ins.run('free',  'Free',    0,   10,  '["3 gerações/mês","Todos os agentes","Histórico básico"]');
      ins.run('pro',   'Pro',     97,  100, '["100 gerações/mês","Todos os agentes","Histórico completo","Suporte prioritário"]');
      ins.run('elite', 'Elite',   197, 300, '["300 gerações/mês","Todos os agentes","Calendário editorial","API access","Suporte dedicado"]');
    }

    // Seed default admin if empty
    const adminCount = this.db.prepare(`SELECT COUNT(*) as c FROM users WHERE role='admin'`).get();
    if (adminCount.c === 0) {
      this._seedAdmin();
    }
  }

  _migrate() {
    // Migrate from legacy JSON if it exists and SQLite has no non-admin users
    if (!fs.existsSync(LEGACY_JSON)) return;
    const userCount = this.db.prepare(`SELECT COUNT(*) as c FROM users WHERE role != 'admin'`).get();
    if (userCount.c > 0) return; // already migrated

    try {
      const raw = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
      const insertUser = this.db.prepare(`
        INSERT OR IGNORE INTO users
        (id,name,email,password,role,plan,quota_used,quota_limit,status,profissao,nicho,publico,tom,cores,estilo,redes,last_login,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const insertGen = this.db.prepare(`
        INSERT OR IGNORE INTO generations
        (id,user_id,feature,format,network,concept_name,prompt,input_tokens,output_tokens,total_tokens,cost_usd,credits_used,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      let migratedUsers = 0, migratedGens = 0;

      if (Array.isArray(raw.users)) {
        for (const u of raw.users) {
          try {
            insertUser.run(
              u.id || this._id(), u.name || '', u.email || '', u.password || '',
              u.role || 'user', u.plan || 'free', u.quota_used || 0, u.quota_limit || 10,
              u.status || 'active', u.profissao || '', u.nicho || '', u.publico || '',
              u.tom || '', u.cores || '#F5C518, #0D0D0F', u.estilo || 'dark luxury',
              u.redes || 'Instagram', u.last_login || null, u.created_at || new Date().toISOString()
            );
            migratedUsers++;
          } catch (e) { /* skip duplicates */ }
        }
      }

      if (Array.isArray(raw.generations)) {
        for (const g of raw.generations) {
          try {
            insertGen.run(
              g.id || this._id(), g.user_id || '', g.feature || '', g.format || '',
              g.network || '', g.concept_name || '', g.prompt || '',
              g.input_tokens || 0, g.output_tokens || 0, g.total_tokens || 0,
              g.cost_usd || 0, g.credits_used || 1, g.created_at || new Date().toISOString()
            );
            migratedGens++;
          } catch (e) { /* skip */ }
        }
      }

      if (Array.isArray(raw.plans)) {
        const upPlan = this.db.prepare(`UPDATE plans SET price=?, quota=?, features=? WHERE id=?`);
        for (const p of raw.plans) {
          upPlan.run(p.price || 0, p.quota || 10, JSON.stringify(p.features || []), p.id);
        }
      }

      log.info(`[MIGRATE] Legacy JSON → SQLite: ${migratedUsers} users, ${migratedGens} generations`);
    } catch (e) {
      log.error('[MIGRATE] Failed:', e.message);
    }
  }

  _id() { return crypto.randomBytes(8).toString('hex'); }

  _hashSync(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  _verifySync(pw, stored) {
    if (!stored) return false;
    if (stored.startsWith('$2')) {
      // Hash legado bcrypt — não conseguimos verificar sem a lib; sinaliza para o caller
      return 'bcrypt_legacy';
    }
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const h = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
    return h === hash;
  }

  _seedAdmin() {
    const adminPw = process.env.ADMIN_PASSWORD;
    if (!adminPw) {
      log.error('[SEED] ADMIN_PASSWORD não definida. Admin não criado. Defina a variável de ambiente.');
      return;
    }
    const id = this._id();
    const pw = this._hashSync(adminPw);
    this.db.prepare(`
      INSERT OR IGNORE INTO users (id,name,email,password,role,plan,quota_limit,quota_used)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, 'Admin', ADMIN_EMAIL, pw, 'admin', 'elite', 99999, 0);
  }

  // ── USERS ──
  createUser({ name, email, password, role = 'user', plan = 'free' }) {
    const existing = this.db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (existing) throw new Error('E-mail já cadastrado');
    const planData = this.db.prepare('SELECT quota FROM plans WHERE id=?').get(plan);
    const quota_limit = planData?.quota || 10;
    const id = this._id();
    const pw = this._hashSync(password);
    this.db.prepare(`
      INSERT INTO users (id,name,email,password,role,plan,quota_limit,quota_used)
      VALUES (?,?,?,?,?,?,?,0)
    `).run(id, name, email, pw, role, plan, quota_limit);
    return this.getUserById(id);
  }

  getUserById(id) {
    const u = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return null;
    const { password, ...rest } = u;
    return rest;
  }

  getUserByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email=?').get(email);
  }

  updateUser(id, fields) {
    const allowed = ['name','email','password','role','plan','quota_used','quota_limit','status',
                     'profissao','nicho','publico','tom','cores','estilo','redes','onboard_step','last_login'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        if (k === 'password') { sets.push(`password=?`); vals.push(this._hashSync(fields[k])); }
        else if (k === 'plan') {
          sets.push(`plan=?`); vals.push(fields[k]);
          const planData = this.db.prepare('SELECT quota FROM plans WHERE id=?').get(fields[k]);
          if (planData) { sets.push('quota_limit=?'); vals.push(planData.quota); }
        } else { sets.push(`${k}=?`); vals.push(fields[k]); }
      }
    }
    if (sets.length === 0) return this.getUserById(id);
    sets.push(`updated_at=datetime('now')`);
    vals.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals);
    return this.getUserById(id);
  }

  deleteUser(id) {
    const u = this.db.prepare('SELECT email FROM users WHERE id=?').get(id);
    if (!u) throw new Error('Usuário não encontrado');
    if (u.email === ADMIN_EMAIL) throw new Error('Admin master não pode ser excluído');
    this.db.prepare('DELETE FROM users WHERE id=?').run(id);
    return true;
  }

  listUsers({ includeAdmin = false, plan, status, search } = {}) {
    let q = 'SELECT * FROM users WHERE 1=1';
    const params = [];
    if (!includeAdmin) { q += ` AND role != 'admin'`; }
    if (plan)   { q += ' AND plan=?'; params.push(plan); }
    if (status) { q += ' AND status=?'; params.push(status); }
    if (search) { q += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    q += ' ORDER BY created_at DESC';
    return this.db.prepare(q).all(...params).map(({ password, ...u }) => u);
  }

  verifyPassword(email, password) {
    const user = this.getUserByEmail(email);
    if (!user) return null;
    const check = this._verifySync(password, user.password);
    if (check === 'bcrypt_legacy') throw new Error('BCRYPT_LEGACY');
    if (!check) return null;
    this.db.prepare(`UPDATE users SET last_login=datetime('now') WHERE id=?`).run(user.id);
    const { password: _, ...rest } = user;
    return rest;
  }

  // ── GENERATIONS ──
  addGeneration(gen) {
    const inp = gen.input_tokens || 0;
    const out = gen.output_tokens || 0;
    const cost_usd = parseFloat(((inp / 1_000_000 * 3) + (out / 1_000_000 * 15)).toFixed(6));
    const id = this._id();
    this.db.prepare(`
      INSERT INTO generations
      (id,user_id,feature,format,network,concept_name,prompt,svg_data,input_tokens,output_tokens,total_tokens,cost_usd,credits_used)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, gen.user_id, gen.feature || '', gen.format || '', gen.network || '',
      gen.concept_name || '', (gen.prompt || '').slice(0, 500),
      gen.svg_data || '', inp, out, inp + out, cost_usd, gen.credits_used || 1
    );
    return { id, ...gen, cost_usd, total_tokens: inp + out };
  }

  getGenerations({ user_id, limit = 50 } = {}) {
    if (user_id) {
      return this.db.prepare(
        'SELECT * FROM generations WHERE user_id=? ORDER BY created_at DESC LIMIT ?'
      ).all(user_id, limit);
    }
    return this.db.prepare('SELECT * FROM generations ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // Retorna gerações com dados do usuário em uma única query (evita N+1)
  getGenerationsWithUsers({ limit = 1000 } = {}) {
    return this.db.prepare(`
      SELECT g.id, g.user_id, g.feature, g.format, g.network, g.concept_name,
             g.input_tokens, g.output_tokens, g.total_tokens, g.cost_usd,
             g.credits_used, g.created_at,
             u.name AS user_name, u.email AS user_email
      FROM generations g
      LEFT JOIN users u ON g.user_id = u.id
      ORDER BY g.created_at DESC LIMIT ?
    `).all(limit);
  }

  // ── PLANS ──
  getPlans() {
    return this.db.prepare('SELECT * FROM plans').all().map(p => ({
      ...p, features: JSON.parse(p.features || '[]')
    }));
  }

  updatePlan(id, fields) {
    const p = this.db.prepare('SELECT * FROM plans WHERE id=?').get(id);
    if (!p) throw new Error('Plano não encontrado');
    const { name, price, quota, features } = { ...p, ...fields };
    this.db.prepare('UPDATE plans SET name=?,price=?,quota=?,features=? WHERE id=?')
      .run(name, price, quota, JSON.stringify(features || []), id);
    return { id, name, price, quota, features };
  }

  createPlan(fields) {
    if (!fields.id || !fields.name) throw new Error('id e name obrigatórios');
    this.db.prepare('INSERT INTO plans (id,name,price,quota,features) VALUES (?,?,?,?,?)')
      .run(fields.id, fields.name, fields.price || 0, fields.quota || 10, JSON.stringify(fields.features || []));
    return { ...fields, features: fields.features || [] };
  }

  deletePlan(id) {
    if (['free','pro','elite'].includes(id)) throw new Error('Planos padrão não podem ser excluídos');
    this.db.prepare('DELETE FROM plans WHERE id=?').run(id);
    return true;
  }

  // ── PACKAGES ──
  getPackages() {
    return this.db.prepare('SELECT * FROM packages').all();
  }

  createPackage(fields) {
    if (!fields.name) throw new Error('name obrigatório');
    const id = 'pack_' + this._id().slice(0, 8);
    this.db.prepare('INSERT INTO packages (id,name,price,quota,description,active) VALUES (?,?,?,?,?,1)')
      .run(id, fields.name, fields.price || 0, fields.quota || 50, fields.description || '');
    return { id, ...fields, active: 1 };
  }

  updatePackage(id, fields) {
    const p = this.db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!p) throw new Error('Pacote não encontrado');
    const merged = { ...p, ...fields };
    this.db.prepare('UPDATE packages SET name=?,price=?,quota=?,description=?,active=? WHERE id=?')
      .run(merged.name, merged.price, merged.quota, merged.description, merged.active ? 1 : 0, id);
    return merged;
  }

  deletePackage(id) {
    this.db.prepare('DELETE FROM packages WHERE id=?').run(id);
    return true;
  }

  applyPackage(userId, packageId) {
    const pkg = this.db.prepare('SELECT * FROM packages WHERE id=? AND active=1').get(packageId);
    if (!pkg) throw new Error('Pacote não encontrado ou inativo');
    const user = this.getUserById(userId);
    if (!user) throw new Error('Usuário não encontrado');
    return this.updateUser(userId, { quota_limit: (user.quota_limit || 0) + pkg.quota });
  }

  // ── SETTINGS ──
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    return rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  }

  updateSettings(fields) {
    const insert = this.db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
    for (const [k, v] of Object.entries(fields)) insert.run(k, String(v));
    return this.getSettings();
  }

  // ── SAVED DESIGNS ──
  saveDesign({ user_id, svg, prompt, format, network, voice_id, voice_name }) {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO saved_designs (id, user_id, svg, prompt, format, network, voice_id, voice_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, user_id, svg, prompt || '', format || 'post', network || 'instagram', voice_id || '', voice_name || '');
    return id;
  }

  getSavedDesigns({ user_id, limit = 50 } = {}) {
    return this.db.prepare(
      'SELECT id, user_id, prompt, format, network, voice_id, voice_name, created_at FROM saved_designs WHERE user_id=? ORDER BY created_at DESC LIMIT ?'
    ).all(user_id, limit);
  }

  getSavedDesignSvg(id, user_id) {
    return this.db.prepare(
      'SELECT id, svg, prompt, format, network FROM saved_designs WHERE id=? AND user_id=?'
    ).get(id, user_id);
  }

  deleteSavedDesign(id, user_id) {
    const r = this.db.prepare('DELETE FROM saved_designs WHERE id=? AND user_id=?').run(id, user_id);
    return r.changes > 0;
  }

  // ── CALENDAR ── (BLOCO 3 — novo)
  getCalendarPosts({ user_id, month, year } = {}) {
    let q = 'SELECT * FROM calendar_posts WHERE user_id=?';
    const params = [user_id];
    if (month && year) {
      q += ` AND scheduled_at >= ? AND scheduled_at < ?`;
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const nextMonth = month === 12 ? `${year+1}-01-01` : `${year}-${String(month+1).padStart(2,'0')}-01`;
      params.push(start, nextMonth);
    }
    q += ' ORDER BY scheduled_at ASC, created_at DESC';
    return this.db.prepare(q).all(...params);
  }

  getCalendarPost(id, user_id) {
    return this.db.prepare('SELECT * FROM calendar_posts WHERE id=? AND user_id=?').get(id, user_id);
  }

  createCalendarPost({ user_id, title, content, format, network, status, scheduled_at, color, agent_slug, generation_id }) {
    this._validateCalendarFields({ title, format, network, status, color, scheduled_at });
    const id = this._id();
    this.db.prepare(`
      INSERT INTO calendar_posts (id,user_id,title,content,format,network,status,scheduled_at,color,agent_slug,generation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, user_id, title || '', content || '', format || 'post', network || 'instagram',
       status || 'idea', scheduled_at || null, color || '#F5C518', agent_slug || '', generation_id || '');
    return this.getCalendarPost(id, user_id);
  }

  _validateCalendarFields(fields) {
    const VALID_STATUS  = ['idea', 'draft', 'ready', 'published'];
    const VALID_FORMAT  = ['post', 'carrossel', 'story', 'reels', 'anuncio', 'thumb', 'banner'];
    const VALID_NETWORK = ['instagram', 'linkedin', 'youtube', 'tiktok', 'facebook'];
    const HEX_RE        = /^#[0-9A-Fa-f]{6}$/;
    const ISO_DATE_RE   = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
    if (fields.status !== undefined && !VALID_STATUS.includes(fields.status))
      throw new Error(`status inválido. Aceitos: ${VALID_STATUS.join(', ')}`);
    if (fields.format !== undefined && !VALID_FORMAT.includes(fields.format))
      throw new Error(`format inválido. Aceitos: ${VALID_FORMAT.join(', ')}`);
    if (fields.network !== undefined && !VALID_NETWORK.includes(fields.network))
      throw new Error(`network inválido. Aceitos: ${VALID_NETWORK.join(', ')}`);
    if (fields.color !== undefined && !HEX_RE.test(fields.color))
      throw new Error('color inválido. Use formato #RRGGBB');
    if (fields.scheduled_at !== undefined && fields.scheduled_at !== null && !ISO_DATE_RE.test(fields.scheduled_at))
      throw new Error('scheduled_at inválido. Use formato ISO (YYYY-MM-DD ou YYYY-MM-DDTHH:MM)');
    if (fields.title !== undefined && (typeof fields.title !== 'string' || fields.title.trim().length === 0))
      throw new Error('title não pode ser vazio');
  }

  updateCalendarPost(id, user_id, fields) {
    const post = this.getCalendarPost(id, user_id);
    if (!post) throw new Error('Post não encontrado');
    this._validateCalendarFields(fields);
    const allowed = ['title','content','format','network','status','scheduled_at','color','agent_slug'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(fields[k]); }
    }
    if (sets.length === 0) return post;
    sets.push(`updated_at=datetime('now')`);
    vals.push(id, user_id);
    this.db.prepare(`UPDATE calendar_posts SET ${sets.join(',')} WHERE id=? AND user_id=?`).run(...vals);
    return this.getCalendarPost(id, user_id);
  }

  deleteCalendarPost(id, user_id) {
    const r = this.db.prepare('DELETE FROM calendar_posts WHERE id=? AND user_id=?').run(id, user_id);
    if (r.changes === 0) throw new Error('Post não encontrado');
    return true;
  }

  getCalendarStats(user_id) {
    const total    = this.db.prepare(`SELECT COUNT(*) as c FROM calendar_posts WHERE user_id=?`).get(user_id).c;
    const idea     = this.db.prepare(`SELECT COUNT(*) as c FROM calendar_posts WHERE user_id=? AND status='idea'`).get(user_id).c;
    const draft    = this.db.prepare(`SELECT COUNT(*) as c FROM calendar_posts WHERE user_id=? AND status='draft'`).get(user_id).c;
    const ready    = this.db.prepare(`SELECT COUNT(*) as c FROM calendar_posts WHERE user_id=? AND status='ready'`).get(user_id).c;
    const published = this.db.prepare(`SELECT COUNT(*) as c FROM calendar_posts WHERE user_id=? AND status='published'`).get(user_id).c;
    return { total, idea, draft, ready, published };
  }


  // ── QUOTA (atômico — sem race condition) ──
  getMemory(userId) {
    const row = this.db.prepare('SELECT * FROM agent_memory WHERE user_id = ?').get(userId);
    if (!row) return { summary: '', preferences: {}, negative: [], positive: [], gen_count: 0 };
    return {
      summary:     row.summary || '',
      preferences: this._safeJson(row.preferences, {}),
      negative:    this._safeJson(row.negative, []),
      positive:    this._safeJson(row.positive, []),
      gen_count:   row.gen_count || 0,
    };
  }

  _safeJson(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  upsertMemory(userId, data) {
    const existing = this.db.prepare('SELECT gen_count FROM agent_memory WHERE user_id = ?').get(userId);
    const genCount = (existing ? (existing.gen_count || 0) : 0) + (data.incrementGen ? 1 : 0);
    var upsertSql = "INSERT INTO agent_memory (user_id, summary, preferences, negative, positive, gen_count, last_updated) " +
      "VALUES (?, ?, ?, ?, ?, ?, datetime('now')) " +
      "ON CONFLICT(user_id) DO UPDATE SET summary=excluded.summary, preferences=excluded.preferences, " +
      "negative=excluded.negative, positive=excluded.positive, gen_count=excluded.gen_count, last_updated=excluded.last_updated";
    this.db.prepare(upsertSql).run(userId, data.summary || '', JSON.stringify(data.preferences || {}),
      JSON.stringify(data.negative || []), JSON.stringify(data.positive || []), genCount);
    return genCount;
  }

  addFeedback(userId, generationId, rating, note) {
    this.db.prepare("INSERT INTO generation_feedback (id, user_id, generation_id, rating, note, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(this._id(), userId, generationId, rating, note || '');
  }

  getRecentGenerations(userId, limit) {
    return this.db.prepare(
      'SELECT id, feature, format, network, concept_name, prompt, created_at FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit || 10);
  }

  consumeQuota(userId) {
    const result = this.db.prepare(
      `UPDATE users SET quota_used = quota_used + 1, updated_at = datetime('now')
       WHERE id = ? AND quota_used < quota_limit`
    ).run(userId);
    if (result.changes === 0) throw new Error('Cota mensal esgotada. Faça upgrade do seu plano.');
    return true;
  }

  resetMonthlyQuotas() {
    this.db.prepare(`UPDATE users SET quota_used = 0, updated_at = datetime('now')`).run();
  }

  // ── LOGIN RATE LIMITING (SQLite) ──
  loginRateCheck(identifier, maxAttempts = 10, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    // Remove entradas expiradas
    this.db.prepare('DELETE FROM login_attempts WHERE first_at < ?').run(now - windowMs);
    const entry = this.db.prepare('SELECT count, first_at FROM login_attempts WHERE identifier=?').get(identifier);
    if (!entry) {
      this.db.prepare('INSERT INTO login_attempts (identifier, count, first_at) VALUES (?, 1, ?)').run(identifier, now);
      return { blocked: false };
    }
    const newCount = entry.count + 1;
    this.db.prepare('UPDATE login_attempts SET count=? WHERE identifier=?').run(newCount, identifier);
    if (newCount > maxAttempts) {
      const retryAfter = Math.ceil((windowMs - (now - entry.first_at)) / 1000);
      return { blocked: true, retryAfter: Math.max(retryAfter, 0) };
    }
    return { blocked: false };
  }

  loginRateClear(identifier) {
    this.db.prepare('DELETE FROM login_attempts WHERE identifier=?').run(identifier);
  }
  // ── STATS ──
  getStats() {
    const users  = this.db.prepare(`SELECT * FROM users WHERE role != 'admin'`).all();
    const plans  = this.getPlans();
    const breakdown = {};
    plans.forEach(p => { breakdown[p.id] = users.filter(u => u.plan === p.id).length; });
    const mrr = users.reduce((s, u) => {
      const plan = plans.find(p => p.id === u.plan);
      return s + (plan?.price || 0);
    }, 0);
    const gStmt = this.db.prepare('SELECT * FROM generations ORDER BY created_at DESC');
    const gens = gStmt.all();
    const totalCostUsd = gens.reduce((s, g) => s + (g.cost_usd || 0), 0);
    const totalTokens  = gens.reduce((s, g) => s + (g.total_tokens || 0), 0);
    const byFeature = {};
    gens.forEach(g => {
      const f = g.feature || g.format || 'unknown';
      if (!byFeature[f]) byFeature[f] = { uses:0, cost_usd:0, tokens:0 };
      byFeature[f].uses++;
      byFeature[f].cost_usd += (g.cost_usd || 0);
      byFeature[f].tokens   += (g.total_tokens || 0);
    });
    const byMonth = {};
    gens.forEach(g => {
      const m = (g.created_at || '').slice(0, 7) || 'unknown';
      if (!byMonth[m]) byMonth[m] = { count:0, cost_usd:0 };
      byMonth[m].count++;
      byMonth[m].cost_usd += (g.cost_usd || 0);
    });
    const userCosts = {};
    gens.forEach(g => {
      if (!userCosts[g.user_id]) userCosts[g.user_id] = { cost_usd:0, count:0 };
      userCosts[g.user_id].cost_usd += (g.cost_usd || 0);
      userCosts[g.user_id].count++;
    });
    const topEntries = Object.entries(userCosts)
      .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
      .slice(0, 5);
    const topIds = topEntries.map(([uid]) => uid);
    const usersMap = {};
    if (topIds.length > 0) {
      const ph = topIds.map(() => '?').join(',');
      this.db.prepare(`SELECT id, name, email FROM users WHERE id IN (${ph})`).all(...topIds)
        .forEach(u => { usersMap[u.id] = u; });
    }
    const topUsers = topEntries.map(([uid, d]) => {
      const u = usersMap[uid];
      return { user_id:uid, name:u?.name||'Desconhecido', email:u?.email||'',
               cost_usd: parseFloat(d.cost_usd.toFixed(6)), count: d.count };
    });
    return {
      total_users: users.length,
      active_users: users.filter(u => u.status === 'active').length,
      total_generations: gens.length,
      plan_breakdown: breakdown,
      mrr, total_cost_usd: parseFloat(totalCostUsd.toFixed(6)),
      total_tokens: totalTokens, by_feature: byFeature, by_month: byMonth,
      top_users_by_cost: topUsers
    };
  }
}

const db = new Database();

// ─────────────────────────────────────────────
// ANTHROPIC API — standard + streaming
// ─────────────────────────────────────────────

function callClaude({ system, userMsg, maxTokens = 2000 }) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_KEY) return reject(new Error('ANTHROPIC_API_KEY não configurada.'));
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }]
    });
    const opts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_KEY,
                 'anthropic-version':'2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message || 'Erro Anthropic'));
          resolve({
            text: p.content?.[0]?.text || '',
            inputTokens: p.usage?.input_tokens || 0,
            outputTokens: p.usage?.output_tokens || 0
          });
        } catch { reject(new Error('Resposta inválida da API')); }
      });
    });
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Anthropic API timeout (90s)')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function callClaudeMessages({ system, messages, maxTokens = 2500 }) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_KEY) return reject(new Error('ANTHROPIC_API_KEY não configurada.'));
    const body = JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:maxTokens, system, messages });
    const opts = {
      hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY,
                 'anthropic-version':'2023-06-01', 'Content-Length':Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message || 'Erro Anthropic'));
          resolve({
            text: p.content?.[0]?.text || '',
            inputTokens: p.usage?.input_tokens || 0,
            outputTokens: p.usage?.output_tokens || 0,
          });
        } catch { reject(new Error('Resposta inválida da API')); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Anthropic web search (beta: web-search-2025-03-05) ────────────────────────
// Igual ao callClaudeMessages mas com a tool web_search disponível para o modelo.
// O response pode ter múltiplos blocos (tool_use + tool_result + text) — extrai o último text.
function callClaudeMessagesWithSearch({ system, messages, maxTokens = 1400 }) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_KEY) return reject(new Error('ANTHROPIC_API_KEY não configurada.'));
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    });
    const opts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message || 'Erro Anthropic'));
          // Busca o último bloco de texto (tool_use/tool_result precedem a resposta final)
          const textBlocks = (p.content || []).filter(b => b.type === 'text');
          const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : '';
          resolve({
            text,
            inputTokens: p.usage?.input_tokens || 0,
            outputTokens: p.usage?.output_tokens || 0,
          });
        } catch { reject(new Error('Resposta inválida da API')); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/**
 * STREAMING — Server-Sent Events (SSE)
 * Envia chunks para o cliente à medida que Claude responde.
 * O cliente recebe eventos: { type: 'delta', text: '...' } | { type: 'done' } | { type: 'error', message: '...' }
 */
function callClaudeStream({ system, messages, maxTokens = 2500, onChunk, onDone, onError }) {
  if (!ANTHROPIC_KEY) { onError(new Error('ANTHROPIC_API_KEY não configurada.')); return; }

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system,
    messages,
    stream: true
  });

  const opts = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body)
    }
  };

  const req = https.request(opts, res => {
    let fullText = '';
    let inputTokens = 0, outputTokens = 0;

    res.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const text = evt.delta.text || '';
            fullText += text;
            onChunk(text);
          }
          if (evt.type === 'message_delta' && evt.usage) {
            outputTokens = evt.usage.output_tokens || 0;
          }
          if (evt.type === 'message_start' && evt.message?.usage) {
            inputTokens = evt.message.usage.input_tokens || 0;
          }
        } catch { /* skip malformed SSE line */ }
      }
    });

    res.on('end', () => {
      onDone(fullText, { inputTokens, outputTokens });
    });
  });

  req.on('error', onError);
  req.write(body);
  req.end();
}

// ─────────────────────────────────────────────
// AGENT SKILLS (mantido igual ao v12)
// ─────────────────────────────────────────────

// ─── AGENT MEMORY SYSTEM ──────────────────────────────────────────────────────

function buildMemoryContext(memory) {
  var parts = [];
  if (memory.summary) parts.push('MEMORIA DO USUARIO (aprendizado acumulado):\n' + memory.summary);
  var prefs = memory.preferences || {};
  if (Object.keys(prefs).length > 0) {
    var prefLines = Object.keys(prefs).map(function(k) { return '  - ' + k + ': ' + prefs[k]; }).join('\n');
    parts.push('PREFERENCIAS APRENDIDAS:\n' + prefLines);
  }
  if (memory.positive && memory.positive.length > 0) {
    var posLines = memory.positive.slice(-5).map(function(p) { return '  + ' + p; }).join('\n');
    parts.push('O QUE FUNCIONA PARA ESTE USUARIO:\n' + posLines);
  }
  if (memory.negative && memory.negative.length > 0) {
    var negLines = memory.negative.slice(-5).map(function(n) { return '  - ' + n; }).join('\n');
    parts.push('O QUE NAO FUNCIONA (evite):\n' + negLines);
  }
  return parts.length > 0 ? ('\n\n--- CONTEXTO DE MEMORIA ---\n' + parts.join('\n\n') + '\n--- FIM DA MEMORIA ---') : '';
}

async function maybeSummarizeMemory(userId, genCount, recentGens) {
  if (genCount % 5 !== 0 || genCount === 0) return;
  if (!recentGens || recentGens.length < 3) return;
  try {
    var lines = recentGens.slice(0, 15).map(function(g) {
      return '- ' + (g.feature || 'conteudo') + ' | ' + (g.format || '') + ' | ' + (g.network || '') + ' | tema: "' + ((g.prompt || '').slice(0, 80)) + '"';
    }).join('\n');
    var { text: summary } = await callClaudeMessages({
      system: 'Voce e um analista de padroes de conteudo. Analise o historico e extraia insights sobre padroes, preferencias e estilo do usuario. Maximo 200 palavras. Responda em portugues.',
      messages: [{ role: 'user', content: 'Historico:\n' + lines + '\n\nExtraia: formatos preferidos, temas recorrentes, redes usadas, padroes de conteudo.' }],
      maxTokens: 300,
    });
    var currentMemory = db.getMemory(userId);
    db.upsertMemory(userId, { summary: summary.trim(), preferences: currentMemory.preferences || {}, positive: currentMemory.positive || [], negative: currentMemory.negative || [], incrementGen: false });
    log.info('[MEMORY] Summarized for user ' + userId);
  } catch(e) { log.error('[MEMORY] Summary failed:', e.message); }
}

function getAgentStructure(slug) {
  var structures = {
    legenda: 'GERE UMA LEGENDA COMPLETA:\n\n GANCHOS (1-2 linhas): Frase que para o scroll. Numeros, contraste ou afirmacao polêmica.\n\n DESENVOLVIMENTO (3-5 paragrafos): Valor real, insight, dado concreto. Max 3 frases por paragrafo.\n\n VIRADA (1 paragrafo): O insight que muda a perspectiva.\n\n CTA (1-2 linhas): Acao especifica, nao generica.\n\n HASHTAGS (10-15): Mix nicho amplo, especifico, micro-nicho.',
    'roteiro-reels': 'GERE ROTEIRO DE REELS (30-60s):\n\n[0-3s] GANCHO VISUAL+VERBAL: prende imediatamente\n[3-15s] PROBLEMA/CONTEXTO: dor que o publico reconhece\n[15-40s] DESENVOLVIMENTO: 3 pontos concisos com payoff\n[40-55s] VIRADA: insight principal\n[55-60s] CTA: call to action claro\n\nINCLUA indicacoes entre colchetes [camera, acao, texto na tela].',
    'roteiro-yt': 'GERE ROTEIRO YOUTUBE:\n1. TITULO SEO (max 60 chars + variacao clickbait)\n2. THUMBNAIL CONCEPT\n3. ROTEIRO: Hook(0-30s) | Intro(30s-2min) | Desenvolvimento com timestamps | Conclusao+CTA\n4. DESCRICAO SEO com keywords e timestamps\n5. TAGS (20 relevantes)',
    story: 'GERE SEQUENCIA DE STORIES (5-7 slides):\n\nPor slide:\nSLIDE X:\n- Tipo: [pergunta/afirmacao/revelacao/CTA]\n- Texto principal: (max 10 palavras)\n- Texto secundario: (max 15 palavras)\n- Elemento interativo: [enquete/pergunta/slider/link]\n- Visual: [cor sugerida, sticker]\n\nREGRA: cada slide cria curiosidade para o proximo.',
    linkedin: 'GERE POST LINKEDIN:\n\nLINHA 1 (GANCHO): interrompe antes do "ver mais". Max 140 chars.\nPARAGRAFO 2: contexto ou historia que valida.\nDESENVOLVIMENTO: insights praticos, dados reais. Se lista: max 5 itens.\nCONCLUSAO: posicionamento claro, opiniao forte.\nENGAJAMENTO: pergunta que convida resposta genuina.',
    tiktok: 'GERE ROTEIRO TIKTOK (15-60s):\n\n[0-3s] HOOK: primeiras palavras = tudo. Choca ou promete algo especifico.\n[3-20s] CONFLITO: situacao que o publico vive. Rapido. Direto.\n[20-50s] RESOLUCAO: solucao em 3 pontos, uma frase cada.\n[50-60s] CTA: "Segue para mais" ou "Comenta X se..."',
  };
  return structures[slug] || 'GERE O CONTEUDO SOLICITADO (' + slug + '):\nEstruture com gancho forte, desenvolvimento claro e CTA direto.';
}

async function runAgentPipeline(opts) {
  var agent = opts.agent, input = opts.input, user = opts.user, memory = opts.memory;
  var tomOverride = opts.tomOverride, mediaFiles = opts.mediaFiles;

  var tom       = tomOverride || (user && user.tom)       || 'autoridade';
  var nicho     = (user && user.nicho)     || 'negocios';
  var profissao = (user && user.profissao) || 'criador de conteudo';
  var publico   = (user && user.publico)   || 'profissionais';
  var redes     = (user && user.redes)     || 'Instagram';
  var estilo    = (user && user.estilo)    || 'moderno';
  var memCtx    = buildMemoryContext(memory || { summary: '', preferences: {}, positive: [], negative: [] });

  var sysStrategist = 'Voce e o ESTRATEGISTA do AutoPostt. Analisa o input e define a melhor abordagem ANTES de qualquer geracao.\n\n' +
    'PERFIL: profissao=' + profissao + ' | nicho=' + nicho + ' | tom=' + tom + ' | publico=' + publico + ' | redes=' + redes + memCtx + '\n\n' +
    'Entregue SEM introducoes:\nANGULO: [o angulo unico para este conteudo]\nGANCHO: [primeira linha que para o scroll, max 10 palavras]\nESTRUTURA: [como organizar para maximo impacto]\nTOM_ESPECIFICO: [nuances de tom para este conteudo]\nEVITAR: [o que nao fazer para este usuario especifico]';

  var resultStrategist = await callClaude({ system: sysStrategist, userMsg: 'INPUT: "' + input + '"\nAGENTE: ' + agent + '\n\nDefina a estrategia:', maxTokens: 400 });
  var brief = resultStrategist.text;

  var sysCopywriter = 'Voce e o COPYWRITER do AutoPostt. Especialista em conteudo de alta conversao para redes sociais.\n\n' +
    'PERFIL: profissao=' + profissao + ' | nicho=' + nicho + ' | tom=' + tom + ' | publico=' + publico + memCtx + '\n\n' +
    'BRIEFING ESTRATEGICO (siga rigorosamente):\n' + brief + '\n\n' +
    'REGRA: Entregue APENAS o conteudo final pronto para usar. Zero introducoes, zero explicacoes.';

  var agentStructure = getAgentStructure(agent);
  var userMsg = 'INPUT ORIGINAL: "' + input + '"\n\n' + agentStructure;
  var messages;
  if (mediaFiles && mediaFiles.length) {
    var content = [];
    mediaFiles.slice(0, 3).forEach(function(mf) {
      if (mf.isVideo) content.push({ type: 'text', text: '[MIDIA: video "' + mf.name + '"]' });
      else content.push({ type: 'image', source: { type: 'base64', media_type: mf.mime || 'image/jpeg', data: mf.base64 } });
    });
    content.push({ type: 'text', text: userMsg });
    messages = [{ role: 'user', content: content }];
  } else {
    messages = [{ role: 'user', content: userMsg }];
  }

  var resultCopy = await callClaudeMessages({ system: sysCopywriter, messages: messages, maxTokens: 2500 });
  return {
    content: resultCopy.text,
    brief,
    inputTokens:  (resultStrategist.inputTokens  || 0) + (resultCopy.inputTokens  || 0),
    outputTokens: (resultStrategist.outputTokens || 0) + (resultCopy.outputTokens || 0),
  };
}

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
Máximo 3 frases por parágrafo. Linguagem direta e conversacional.

━━ VIRADA (1 parágrafo)
O ponto de transformação. A insight principal. O que muda a perspectiva.

━━ CTA (1-2 linhas)
Ação específica. Não genérico. Conectado ao conteúdo.

━━ HASHTAGS (10-15)
Mix: 3 nicho amplo (100k-1M), 5 nicho específico (10k-100k), 3 micro-nicho (<10k), 2 trend.`,

    'roteiro-reels': base + `

SKILL: ROTEIRO DE REELS (30-60 segundos)

ESTRUTURA OBRIGATÓRIA:
[0-3s] GANCHO VISUAL + VERBAL
Ação ou fala que prende imediatamente. Promessa clara do que virá.

[3-15s] PROBLEMA / CONTEXTO
Identifica a dor ou situação que o público reconhece.

[15-40s] DESENVOLVIMENTO
3 pontos ou passos concisos. Cada um com 1 frase de payoff.

[40-55s] VIRADA / RESULTADO
O insight principal. O que transforma.

[55-60s] CTA
Call to action claro e específico.

DIREÇÃO DE CÂMERA: Inclua indicações entre colchetes [câmera, ação, texto na tela].`,

    'roteiro-yt': base + `

SKILL: ROTEIRO DE YOUTUBE (estrutura completa)

ENTREGUE:
1. TÍTULO SEO-OTIMIZADO (máx 60 chars + variação clickbait)
2. THUMBNAIL CONCEPT (o que mostrar na imagem)
3. ROTEIRO COMPLETO:
   - Hook (0-30s): promessa irresistível
   - Intro (30s-2min): credibilidade + preview do conteúdo
   - Desenvolvimento (corpo): tópicos com timestamps sugeridos
   - Conclusão + CTA: próximo passo claro
4. DESCRIÇÃO SEO (com keywords, links placeholder, timestamps)
5. TAGS (20 tags relevantes)`,

    story: base + `

SKILL: SEQUÊNCIA DE STORIES (5-7 slides)

Crie uma sequência narrativa de stories que guia o seguidor através de uma jornada.

FORMATO POR SLIDE:
SLIDE X:
- Tipo: [pergunta/afirmação/revelação/CTA]
- Texto principal: (máx 10 palavras)
- Texto secundário: (máx 15 palavras)
- Elemento interativo: [enquete/caixa de pergunta/slider/link]
- Indicação visual: [cor de fundo, sticker sugerido]

REGRA: Cada slide deve criar curiosidade para o próximo.`,

    linkedin: base + `

SKILL: POST LINKEDIN DE AUTORIDADE

ESTRUTURA:
━━ LINHA 1 (GANCHO)
Deve ser interrompida antes do "ver mais". Provocativa. Máx 140 chars.

━━ PARÁGRAFO 2
Contexto ou história pessoal que valida o que vem a seguir.

━━ DESENVOLVIMENTO (lista ou parágrafos)
Insights práticos, dados reais, exemplos concretos.
Se lista: máx 5 itens, cada um com 1 linha de contexto.

━━ CONCLUSÃO
Posicionamento claro. Opinião forte. Sem neutralidade.

━━ ENGAJAMENTO
Pergunta que convida resposta genuína.

Tom: profissional mas humano. Autoridade sem arrogância.`,

    tiktok: base + `

SKILL: ROTEIRO TIKTOK (15-60 segundos)

FÓRMULA: Hook → Conflito → Resolução → CTA

[0-3s] HOOK (verbal + visual)
Primeiras palavras = tudo. Deve chocar, provocar ou prometer algo específico.

[3-20s] CONFLITO / PROBLEMA
A situação que o público vive. Rápido. Direto.

[20-50s] RESOLUÇÃO
A solução, hack ou insight. 3 pontos máximo.
Cada ponto = 1 frase. Ritmo rápido.

[50-60s] CTA
"Segue para mais" / "Comenta X se você..."

RITMO: Uma nova informação a cada 2-3 segundos.
TOM: Coloquial, direto, energia alta.`
  };

  return skills[slug] || base;
}

function getConceptsSkill(user) {
  const cores = user?.cores || '#F06B28, #0A0D10';
  const nicho = user?.nicho || 'marketing digital';
  const profissao = user?.profissao || 'criador de conteúdo';
  const estilo = user?.estilo || 'dark luxury';
  return `Você é um diretor criativo especialista em campanhas visuais para redes sociais.
  
PERFIL DA MARCA:
- Profissão: ${profissao}
- Nicho: ${nicho}  
- Cores: ${cores}
- Estilo visual: ${estilo}

TAREFA: Gere 3 conceitos visuais distintos para a ideia fornecida.

RESPONDA APENAS com um array JSON válido. Zero texto antes ou depois. Formato exato:
[
  {
    "name": "Nome do conceito (2-3 palavras)",
    "approach": "Abordagem criativa em 1 frase",
    "emotion": "Emoção principal + emoção secundária",
    "vision": "Descrição visual detalhada do que o espectador vê",
    "prompt": "Prompt completo para geração de imagem"
  }
]

REGRAS dos prompts:
- Sempre em inglês
- Nunca incluir texto ou palavras na imagem
- Referenciar as cores: ${cores}
- Estilo ${estilo}
- Ultra-realista ou cinematográfico
- No text, no watermarks, no logos`;
}

function getRefineSkill(user, opts) {
  const p = user || {};
  const modelN    = opts?.modelN    || '';
  const modelName = opts?.modelName || '';
  const modelSvg  = opts?.modelSvg  || '';
  const bp        = opts?.brandPalette || {};

  // Extract text placeholders from model SVG
  let modelTextSlots = '';
  if (modelSvg) {
    const matches = [...modelSvg.matchAll(/>([^<\n]{2,60})</g)]
      .map(m => m[1].trim())
      .filter(t => {
        if (t.length < 2) return false;
        if (/^[\d\s\.\-\,\%px·]+$/.test(t)) return false;
        if (/^(IBM Plex|Bebas|Playfair|Cormorant|DM Sans|Syne|Regular|Bold|Light|Black|Italic|Mono|Sans|Serif)/i.test(t)) return false;
        return true;
      });
    const unique = [...new Set(matches)].slice(0, 14);
    if (unique.length) modelTextSlots = '\nTEXTOS DO MODELO (substitua cada um pelo conteúdo real do tema):\n' + unique.map((t,i) => `${i+1}. "${t}"`).join('\n');
  }

  const paletteCtx = (bp.primaria || bp.secundaria)
    ? `\nPALETA DA MARCA:\n- Primária (destaque/accent): ${bp.primaria || '#F5C518'}\n- Secundária (fundo principal): ${bp.secundaria || '#0D0D0F'}\n- Terciária (texto/contraste): ${bp.terciaria || '#F5F4F0'}\n- Quaternária (suporte): ${bp.quaternaria || '#888888'}`
    : '';

  const voiceId   = opts?.voiceId   || '';
  const voiceName = opts?.voiceName || '';
  const voiceCtx  = voiceId
    ? `\nVOZ DA MARCA: ${voiceName || voiceId} — ${BRAND_VOICES[voiceId] ? BRAND_VOICES[voiceId].split('\n')[0] : voiceName}`
    : (modelN ? `\nMODELO DE REFERÊNCIA: ${modelN} — ${modelName}${modelTextSlots}` : '');

  return `Você é um especialista em marketing, copy e direção de arte para redes sociais.
Sua função é refinar o input em um prompt rico que a IA usará para gerar a imagem final.

PERFIL DO USUÁRIO:
- Profissão: ${p.profissao || 'criador de conteúdo'}
- Nicho: ${p.nicho || 'negócios'}
- Tom de voz: ${p.tom || 'autoridade'}
- Público-alvo: ${p.publico || 'profissionais'}${paletteCtx}${voiceCtx}

REGRAS ABSOLUTAS:
1. O prompt refinado DEVE mencionar as cores da paleta nos contextos corretos (destaque, fundo, texto).
2. Inclua conteúdo real para cada slot de texto do modelo (se houver).
3. Preserve todos os números e dados do usuário sem alteração.
4. Expanda narrativa, emoção e contexto de negócio.
5. Retorne APENAS o prompt refinado em 3-5 frases. ZERO introduções ou explicações.
6. O resultado deve ser rico o suficiente para a IA replicar o modelo escolhido com o conteúdo e cores corretos.`;
}
// ─────────────────────────────────────────────
// STYLE DNA — referência de identidade visual dos 20 templates
// ─────────────────────────────────────────────
const STYLE_DNA = {
  '01': `DARK LUXURY — Poder e luxo silencioso
BG: #0A0A0A | micro-grid linhas #FFFFFF opacity:0.025 step:60px
ACCENT: #C9A84C ouro | linha-vertical-esq x=56 w=3px h=75% da altura
HEADLINE: Bebas Neue 900 | #FFFFFF | 110-140px | UPPERCASE | letter-spacing:2px
CORPO: DM Sans 300 | #9E9E9E | 22-26px | line-height:38px
DECO: círculo outline #C9A84C r=140px opacity:0.08 atrás headline | retangulo accent 5x40px
EFEITO: radial-gradient #C9A84C→transparent opacity:0.12 center | feDropShadow headline
REGRA: 70% espaço negativo — cada elemento intencional, luxo pelo vazio`,

  '02': `EDITORIAL CLEAN — Autoridade jornalística
BG: #FAFAF8 | barra preta #0D0D0F topo h=10px + rodapé h=8px
ACCENT: #0D0D0F | separador horizontal 1px + container rect opcional atrás headline
HEADLINE: Playfair Display 700 | #0D0D0F | 80-110px | mixed case
CORPO: DM Sans 400 | #3D3D3D | 20-22px | line-height:36px
DECO: aspas decorativas 120px #0D0D0F opacity:0.08 | linha vertical dir 1px #CCCCCC
EFEITO: zero efeitos — tipografia É o design
REGRA: barras horizontais ancoram o espaço | composição esparsa e intencional`,

  '03': `SPLIT BOLD — Dualidade e tensão visual
BG: split — top-50% cor-primária | bottom-50% #0D0D0F | linha divisória 3px #FFFFFF glow
ACCENT: #FFFFFF | linha-horizontal 100% em y=50% com glow sutil
HEADLINE: Syne 900 | #FFFFFF | 100-130px | UPPERCASE | DEVE CRUZAR a linha divisória
CORPO: DM Sans 600 | 22px | acima-linha: #0D0D0F | abaixo-linha: #FFFFFF opacity:0.85
DECO: texto ghost opacity:0.06 repetido como textura de fundo
EFEITO: feGaussianBlur na linha divisória stdDev=1 | glow sutil na transição
REGRA: headline DEVE cruzar a linha de corte — tensão entre os dois planos é obrigatória`,

  '04': `TECH GRID — Precisão sistemática
BG: #0C1017 | grid #3A4A5A opacity:0.35 step:40px linhas horiz+vert
ACCENT: cor-primária | linha vertical esq w=4px + círculo sólido 8px no topo da linha
HEADLINE: DM Sans 800 | #E8F0FE | 90-120px | alinhado na grid
CORPO: IBM Plex Mono 400 | cor-primária | 16-18px
DECO: hexágono outline canto inf-dir opacity:0.2 | coordenadas tipográficas pequenas
EFEITO: zero blur — tudo sharp | grid visível como decoração
REGRA: alinhamento rigoroso ao step de 40px | monospace body reforça tema tech`,

  '05': `CODE AESTHETIC — Terminal e autoridade técnica
BG: #0D0D0D | pseudo-código comentado opacity:0.07 preenchendo fundo
ACCENT: #00D4AA verde ou cor-primária | glow em tudo
HEADLINE: IBM Plex Mono 700 | #FFFFFF | 72-96px | prefix "$ " em cor-primária
CORPO: IBM Plex Mono 400 | #7ADFBB | 16-18px | prefix "// " cada ponto
DECO: retangulo terminal borda 1px cor-primária padding:12px | cursor "_" | linha de status
EFEITO: feGaussianBlur halo verde stdDeviation=8 | scanlines 1px opacity:0.06
REGRA: tudo flush-left, espaçamento 8px, paleta monocromática fora do accent`,

  '06': `LUXURY WARM — Elegância atemporal centrada
BG: #FAF6EE creme | noise-texture feTurbulence opacity:0.03
ACCENT: #C9A84C ouro | frame interno 1px 24px da borda | ornamento central linha+losango
HEADLINE: Playfair Display 700 | #1A1A1A | 72-96px | centrado | mixed case
CORPO: Cormorant Garamond 400 italic | #5A4A3A | 22-26px | centrado
DECO: ornamento linha+losango+linha #C9A84C centralizado | frame interno dourado
EFEITO: noise texture sutil | sombra retangular #C9A84C opacity:0.05
REGRA: simetria absoluta — eixo central sagrado, 60px margens generosas`,

  '07': `DATA VISUAL — O número como herói absoluto
BG: #0E1621 | gradiente linear #0E1621→#162030 diagonal
ACCENT: cor-primária | barras mini-gráfico lado direito como decoração
HEADLINE: Syne 800 | #FFFFFF | 80-100px | enquadra e amplifica o dado
DADO: Bebas Neue 900 | cor-primária | 160-200px | 40% do canvas | HERÓI
CORPO: DM Sans 400 | #8AAABE | 20px | label/descrição contextual do dado
DECO: 4-5 barras gráfico canto dir gradiente | linhas grid horiz opacity:0.15
EFEITO: glow no número feGaussianBlur stdDev=12 opacity:0.5 | escala dramática
REGRA: número é o herói — tudo enquadra e amplifica o dado`,

  '08': `NEON IMPACT — Energia e urgência neon
BG: #050505 | radial-gradient cor-primária center opacity:0.15
ACCENT: cor-primária | 4 corner-brackets L-shape 2px nos cantos + linha horizontal center
HEADLINE: Bebas Neue 900 | cor-primária | 120-160px | UPPERCASE | feDropShadow glow
CORPO: DM Sans 600 | #CCCCCC | 24px | uppercase
DECO: scanlines 1px opacity:0.05 | linhas diagonais decorativas opacity:0.08
EFEITO: feDropShadow flood-color=cor-primária stdDeviation=8 | radial glow fundo
REGRA: contraste extremo preto×neon | corner brackets OBRIGATÓRIOS nos 4 cantos`,

  '09': `CLEAN MINIMAL — Confiança pela simplicidade extrema
BG: #FFFFFF puro | zero texturas — espaço negativo É o design
ACCENT: cor-primária | barra vertical esq w=4px h=60% centralizada + bullet círculo 12px
HEADLINE: DM Sans 800 | #0D0D0F | 80-100px | flush-left
CORPO: DM Sans 400 | #555555 | 22-24px | line-height:40px
DECO: CTA retangular sólido cor-primária | separador linha 1px | bullet círculo
EFEITO: zero efeitos — a pureza é o efeito
REGRA: 80px margens, espaçamento 1.5× normal | cada elemento respira`,

  '10': `QUOTE POWER — Impacto emocional pela citação
BG: #0A0A0F escuro ou #FAF8F5 claro baseado no tom da marca
ACCENT: cor-primária | aspas decorativas 80-120px opacity:0.12 atrás do quote
HEADLINE: Cormorant Garamond 700 italic | 60-80px | centrado | quote entre aspas
ATRIB: DM Sans 300 uppercase letter-spacing:4px | #888888 | 14px | "— Fonte/Autor"
DECO: linha horizontal 40px cor-primária centralizada acima+abaixo do quote
EFEITO: feGaussianBlur nas aspas decorativas | linha cor-primária brilhante
REGRA: quote ocupa 60% vertical centrado — silêncio ao redor é obrigatório`,

  '11': `BRAND SOLID — Identidade em tela cheia
BG: cor-primária preenchendo 100% | círculo 600px #FFFFFF opacity:0.06 canto
ACCENT: #FFFFFF | CTA retangulo com texto na cor-primária
HEADLINE: Syne 900 | #FFFFFF ou #0D0D0F AAA contrast | 100-140px
CORPO: Syne 400 | #FFFFFF opacity:0.65 | 22px
DECO: linhas diagonais #FFFFFF opacity:0.03 | padrão geométrico opacity:0.04
EFEITO: noise texture opacity:0.02 | círculo gigante como âncora visual
REGRA: a COR é o design — tipografia confirma, ornamentos decoram discretamente`,

  '12': `STRUCTURED GRID — Organização visual como arte
BG: #F5F5F2 | grid #DEDEDE 1px step:30px visível como textura
ACCENT: cor-primária | barra vertical dir w=6px + highlight rect opacity:0.08 atrás headline
HEADLINE: DM Sans 900 | #0D0D0F | 80-100px | alinhado na grid
CORPO: DM Sans 400 | #444444 | 20-22px | bullet quadrado 8px cor-primária
DECO: número do slide grande opacity:0.07 | marcador de coluna decorativo
EFEITO: sombra sutil no rect do headline | separador 2px
REGRA: cada elemento em coluna do grid — alinhamento perfeccionista ao step`,

  '13': `BRUTALIST — Impacto cru e inquestionável
BG: #000000 absoluto — zero texturas zero gradientes zero ornamentos
ACCENT: #FFFFFF | linha horizontal 4px cortando o canvas em y≈45%
HEADLINE: Bebas Neue 900 | #FFFFFF | 130-180px | UPPERCASE | letter-spacing:0
CORPO: DM Sans 700 | #FFFFFF | 20px | UPPERCASE acima | #888888 abaixo
DECO: ZERO ornamentos — o tipo É o design
EFEITO: ZERO blur ZERO sombras ZERO gradientes — brutalismo puro
REGRA: remove tudo que pode ser removido — o que sobra é o design`,

  '14': `ORGANIC WARM — Humanidade e conexão emocional
BG: #FDF8F2 creme orgânico | círculos sobrepostos como textura sutil
ACCENT: cor-primária | 3 círculos 80px+160px+300px sobrepostos canto inf-dir
HEADLINE: Cormorant Garamond 700 | #1A1A1A | 72-90px
CORPO: Cormorant Garamond 400 italic | #5A4535 | 22-26px
DECO: círculo outline 300px opacity:0.08 + 160px opacity:0.15 + 80px opacity:0.25
EFEITO: preenchimento gradiente radial nos círculos | sobreposição orgânica
REGRA: assimetria intencional — 3 círculos DEVEM aparecer sempre no canto`,

  '15': `TERMINAL GREEN — Estética hacker e dev
BG: #050F05 | scanlines 1px #00FF41 opacity:0.06
ACCENT: #00FF41 phosphor | glow em todo elemento primário
HEADLINE: IBM Plex Mono 700 | #00FF41 | 72-100px | prefix "> " ou "$ " em verde
CORPO: IBM Plex Mono 400 | #00AA2B | 16-18px | prefix "> " em cada ponto
DECO: retangulo terminal borda 1px #00FF41 | linha de status | cursor "_"
EFEITO: feGaussianBlur halo verde stdDeviation=6 em headline | CRT glow
REGRA: monocromático verde — zero outras cores | paleta terminal histórica`,

  '16': `MAGAZINE EDITORIAL — Publicação premium
BG: #FFFFFF | barra cor-primária 12px topo + 8px rodapé | label categoria obrigatório
ACCENT: cor-primária | barra 2px separando label do headline
HEADLINE: Syne 900 | #0D0D0F | 80-110px | pode tocar a barra superior
LABEL: rect cor-primária | DM Sans 700 12px #FFFFFF | CATEGORIA EM MAIÚSCULA
CORPO: DM Sans 400 | #3D3D3D | 20-22px
DECO: drop capital | forma geométrica 40% canvas dir se landscape
EFEITO: gradiente sutil no label | borda angular da barra
REGRA: label de CATEGORIA é OBRIGATÓRIO — linguagem de revista premium de luxo`,

  '17': `COSMIC GEOMETRIC — Profundidade e dimensão espacial
BG: #0C0C14 | radial-gradient cor-primária opacity:0.2 center
ACCENT: cor-primária | círculo 400px + triângulo/polígono sobrepostos opacity:0.3-0.6
HEADLINE: Syne 800 | #FFFFFF | 80-110px | sobre as formas geométricas
CORPO: DM Sans 300 | cor-primária-clara | 20-22px
DECO: 15-20 pontos brancos 2-4px opacity:0.4 espalhados | nebulosa radial difusa
EFEITO: feGaussianBlur formas stdDeviation=30 | glow difuso no fundo
REGRA: formas geométricas grandes criam profundidade — ousado e dramático`,

  '18': `GOLDEN IMPACT — Riqueza e autoridade dourada
BG: cor-primária dourado ou #B8860B | cor sólida — sem gradiente
ACCENT: #0D0D0F escuro | linhas horizontais 3px múltiplas abaixo e acima do headline
HEADLINE: Bebas Neue 900 | #0D0D0F | 110-140px | UPPERCASE
CORPO: DM Sans 700 | #0D0D0F | 20px | UPPERCASE
DECO: 5-7 linhas horizontais paralelas laterais 40px | sombra sutil no headline
EFEITO: text-shadow leve #0D0D0F opacity:0.2 | fundo sólido vibrante
REGRA: inversão total — fundo claro/dourado com tudo escuro`,

  '19': `GLASS MORPHISM — Modernidade translúcida
BG: #06080F | radial-gradient cor-primária center opacity:0.25
GLASS: rect fill rgba(255,255,255,0.07) stroke rgba(255,255,255,0.18) + blur
HEADLINE: Syne 700 | #FFFFFF | 72-96px | dentro do glass card centralizado
CORPO: DM Sans 300 | rgba(255,255,255,0.7) | 20px
DECO: 2-3 blobs cor-primária opacity:0.3 atrás do glass com blur stdDeviation:40
EFEITO: feGaussianBlur nos blobs | borda glass rgba(255,255,255,0.25)
REGRA: glass card centralizado — blobs DEVEM ter blur real via filter SVG`,

  '20': `REFINED MINIMAL — Sofisticação pela ausência absoluta
BG: #F8F7F4 off-white | zero texturas
ACCENT: #C9A84C ouro | linha horizontal 40px w=1px centralizada abaixo do headline
HEADLINE: DM Serif Display 400 italic | #0D0D0F | 64-88px | mixed case
CORPO: DM Sans 300 | #5A5A5A | 18-20px | letter-spacing:0.5px
DECO: círculo outline 1px #0D0D0F opacity:0.1 200px canto sup-dir
EFEITO: zero efeitos — o silêncio é a sofisticação
REGRA: 100px margens — remova tudo que puder sendo ainda funcional`,
};

// ─────────────────────────────────────────────
// BRAND VOICES — 8 personalidades de marca (substituem os 20 modelos visuais)
// Definem DIREÇÃO CRIATIVA (energia, tipografia, layout, efeitos) sem prescrever
// coordenadas exatas — a IA tem liberdade criativa dentro da personalidade.
// ─────────────────────────────────────────────
const BRAND_VOICES = {
  'luxury': `LUXURY PREMIUM — Silêncio como poder
ENERGIA: mínima — cada elemento justifica sua existência
TIPOGRAFIA: serifada display (Playfair Display, Cormorant Garamond) OU condensada ultra-bold (Bebas Neue) para contraste
LAYOUT: generoso espaço negativo (60-80px+ margens), composição assimétrica intencional, hierarquia rigorosa
FUNDO: escuro preferencial (#0A0A0A, #0D0D0F, charcoal profundo) OU creme quente (#FAF6EE) para variante clara
ACCENT: dourado (#C9A84C), platina (#B8B8B8), ou cor da marca em tom premium e dessaturado
DECORAÇÃO: geométrica sutil (linhas finas, frames internos, ornamentos discretos), blur em backgrounds
EFEITOS: radial gradient sutil, drop shadow leve, grain mínimo, profundidade por camadas
REGRA: se em dúvida, remova. Luxo é ausência de esforço visível.`,

  'bold': `BOLD IMPACT — Energia máxima, stop-the-scroll imediato
ENERGIA: máxima — impacto na primeira milissegunda
TIPOGRAFIA: condensada ultra-bold (Bebas Neue 900, Syne 900), UPPERCASE obrigatório, letter-spacing apertado
LAYOUT: denso e urgente, corner brackets nos 4 cantos, linha horizontal central, diagonal elements
FUNDO: preto absoluto #050505 OU cor da marca como background sólido vibrante
ACCENT: neon (cor da marca máxima saturação), branco puro, contraste extremo preto×neon
DECORAÇÃO: L-brackets, linhas diagonais, glow neon, scanlines, formas angulares que sangram
EFEITOS: feDropShadow neon, radial glow, blur halo, contraste brutal sem compromisso
REGRA: se não para o scroll, faça maior, mais contrastante, mais ousado.`,

  'clean': `CLEAN PROFESSIONAL — Confiança pela simplicidade extrema
ENERGIA: média-baixa — cada elemento preciso, respiração ampla
TIPOGRAFIA: geométrica sans-serif (DM Sans 700-800, Syne 700), pesos variados para hierarquia clara
LAYOUT: abundante espaço negativo (80px+ margens), composição arejada, barra vertical accent
FUNDO: branco puro (#FFFFFF, #FAFAF8) OU light gray (#F5F5F2)
ACCENT: cor da marca pontual (barra, bullet, CTA), usado com moderação
DECORAÇÃO: círculo sólido como bullet, linha separadora fina, CTA button com cor da marca
EFEITOS: zero noise, zero glow — a pureza é o efeito
REGRA: 80% do canvas pode ser vazio. O vazio é design premium.`,

  'editorial': `EDITORIAL MAGAZINE — Autoridade pela tipografia como design
ENERGIA: média — refinamento editorial, autoridade estruturada
TIPOGRAFIA: mix serif (Playfair Display 700 italic) + sans (DM Sans 600) — tipografia É o elemento visual
LAYOUT: magazine-style (barras horizontais, separadores, label de categoria obrigatório)
FUNDO: branco editorial (#FAFAF8) OU preto editorial (#0D0D0F) dependendo do tom
ACCENT: cor da marca para barras e labels, preto/branco para tipografia principal
DECORAÇÃO: barras horizontais topo+rodapé, aspas decorativas gigantes opacity:0.1, label de categoria rect
EFEITOS: zero filtros — a tipografia É a decoração
REGRA: headline pode ser ousado, layout deve ser estruturado como uma revista premium.`,

  'tech': `TECH & DIGITAL — Precisão, profundidade e inovação sistemática
ENERGIA: média-alta — sistemático, preciso, profundo, inovador
TIPOGRAFIA: geométrica (DM Sans 800) para headlines + monospace (IBM Plex Mono) para detalhes técnicos
LAYOUT: grid visible como textura, alinhamento rigoroso, coordenadas explícitas no design
FUNDO: escuro azulado (#0C1017, #06080F) OU preto técnico (#0D0D0D)
ACCENT: cor da marca em neon/elétrico, azul elétrico, verde terminal — saturação máxima
DECORAÇÃO: grid pattern, L-brackets, hexágonos, coordenadas, scanlines, polígonos geométricos
EFEITOS: glow técnico feGaussianBlur, filtros nítidos, blur cirúrgico em elementos de bg
REGRA: cada elemento no grid — a precisão sistemática é a estética.`,

  'warm': `WARM & HUMAN — Conexão emocional e acolhimento genuíno
ENERGIA: baixa-média — orgânico, humano, convidativo, próximo
TIPOGRAFIA: serifada humanista (Cormorant Garamond italic, Playfair Display) OU sans amigável (DM Sans 300-400)
LAYOUT: orgânico e assimétrico suave, formas arredondadas, composição natural não-geométrica
FUNDO: tons quentes (#FDF8F2, #FAF6EE, #F5EFE6) OU escuro acolhedor (#1A1410)
ACCENT: terroso, dourado morno, verde sálvia, marsala, terracota — tons orgânicos da natureza
DECORAÇÃO: 3 círculos sobrepostos (organic overlap), grain texture, formas fluidas e orgânicas
EFEITOS: sombras suaves, gradientes quentes, noise grain orgânica feTurbulence
REGRA: se parecer frio ou corporativo, adicione calor. Humanidade e conexão primeiro.`,

  'creative': `CREATIVE & EXPRESSIVE — Surpresa visual que não esquece
ENERGIA: alta — visual inesperado, quebra regras conscientemente
TIPOGRAFIA: mista expressiva — misture pesos, tamanhos variados, posicionamentos inusitados
LAYOUT: assimétrico deliberado, overlaps intencionais, elementos que sangram, composição dinâmica
FUNDO: cor vibrante da marca OU combinação bicolor inesperada (split, diagonal, radial)
ACCENT: combinação cromática ousada, alto contraste, cor como protagonista não como acento
DECORAÇÃO: formas irregulares, polígonos, texto como textura, elementos fora do grid propositalmente
EFEITOS: gradientes vibrantes, mistura de opacidades, composição em muitas camadas
REGRA: o objetivo é ser inesquecível. Se todos fazem X, faça o oposto de X.`,

  'data': `DATA & AUTHORITY — O número como herói absoluto
ENERGIA: média-alta — assertivo, convincente, baseado em evidências concretas
TIPOGRAFIA: display bold (Bebas Neue 900, Syne 900) para números GIGANTES | clean sans para labels
LAYOUT: number-centric — o dado ocupa 35-50% do canvas; tudo ao redor amplifica o número
FUNDO: escuro estruturado (#0E1621, #0C1017) com gradiente diagonal sutil
ACCENT: cor da marca para o número-herói, branco para texto de apoio
DECORAÇÃO: mini gráficos de barras, linhas de grid horizontais, badges de métrica, sparklines
EFEITOS: glow neon no número (feGaussianBlur + feMerge), contexto visual de dados, depth
REGRA: o número É o headline — tudo serve para enquadrar, contextualizar e amplificar o dado.`,
};

// ─────────────────────────────────────────────
// SVG SANITIZER — remove elementos/atributos perigosos
// ─────────────────────────────────────────────
function sanitizeSvg(svg) {
  // Remove blocos <script> completos
  svg = svg.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Remove elementos que podem carregar conteúdo externo ou executar código
  const dangerousTags = ['object', 'embed', 'iframe', 'foreignObject', 'animate', 'set'];
  for (const tag of dangerousTags) {
    svg = svg.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    svg = svg.replace(new RegExp(`<${tag}[^>]*/?>`, 'gi'), '');
  }
  // Remove event handlers inline (onclick, onload, onerror, etc.)
  svg = svg.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '');
  svg = svg.replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
  // Remove href/xlink:href com javascript:
  svg = svg.replace(/\s+(href|xlink:href)\s*=\s*["']javascript:[^"']*["']/gi, '');
  // Remove uso de <use> com href externo (pode carregar SVG externo)
  svg = svg.replace(/<use[^>]*href\s*=\s*["']https?:\/\/[^"']*["'][^>]*\/?>/gi, '');
  return svg;
}

// ─────────────────────────────────────────────
// FONT MANAGER
// Baixa Google Fonts como TTF, injeta no SVG como base64 E salva no disco
// para que librsvg/fontconfig encontre as fontes pelo nome.
// ─────────────────────────────────────────────

const _fontCache = new Map(); // `${family}:${weight}` → { b64, fmt }
const _fontsDir  = path.join(process.env.HOME || '/root', '.local', 'share', 'fonts', 'autopostt');

// Todas as fontes usadas nos templates + brand voices
const DESIGN_FONTS = [
  { family: 'Bebas Neue',          weight: '400' },
  { family: 'Syne',                weight: '700' },
  { family: 'Syne',                weight: '800' },
  { family: 'DM Sans',             weight: '400' },
  { family: 'DM Sans',             weight: '700' },
  { family: 'DM Sans',             weight: '800' },
  { family: 'Playfair Display',    weight: '400' },
  { family: 'Playfair Display',    weight: '700' },
  { family: 'Cormorant Garamond',  weight: '400' },
  { family: 'Cormorant Garamond',  weight: '600' },
  { family: 'IBM Plex Mono',       weight: '400' },
  { family: 'IBM Plex Mono',       weight: '700' },
];

// _httpsGet com User-Agent configurável
function _httpsGetOpts(url, { asBuffer = false, ua = 'AutoPostt/1.0' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'User-Agent': ua },
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return _httpsGetOpts(res.headers.location, { asBuffer, ua }).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : buf.toString('utf8'));
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Utilitário HTTPS genérico (retorna Buffer ou string)
function _httpsGet(url, asBuffer = false) {
  return _httpsGetOpts(url, { asBuffer });
}

// Carrega 1 fonte como TTF (UA antigo força Google Fonts a retornar TTF, que librsvg suporta)
async function _loadOneFont(family, weight) {
  const key = `${family}:${weight}`;
  if (_fontCache.has(key)) return;
  try {
    const familyQ = encodeURIComponent(family) + ':wght@' + weight;
    // UA de Android antigo → Google Fonts retorna TTF (não woff2); librsvg suporta TTF em data URI
    const css = await _httpsGetOpts(
      `https://fonts.googleapis.com/css2?family=${familyQ}&display=swap`,
      { ua: 'Mozilla/5.0 (Linux; Android 2.3.4; GT-I9100 Build/GINGERBREAD)' }
    );
    // Captura todos os URLs de fonte no CSS e prefere TTF
    const allUrls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
    if (!allUrls.length) throw new Error('Nenhuma URL de fonte encontrada no CSS');
    const fontUrl = allUrls.find(u => u.endsWith('.ttf')) || allUrls[0];
    const fmt = fontUrl.endsWith('.woff2') ? 'woff2'
              : fontUrl.endsWith('.woff')  ? 'woff'
              : 'truetype';
    const fontData = await _httpsGet(fontUrl, true);
    _fontCache.set(key, { b64: fontData.toString('base64'), fmt });

    // Salva TTF no disco para fontconfig — librsvg encontra pelo nome da família
    try {
      fs.mkdirSync(_fontsDir, { recursive: true });
      const ext  = fmt === 'truetype' ? '.ttf' : fmt === 'woff2' ? '.woff2' : '.woff';
      const file = path.join(_fontsDir, `${family.replace(/\s+/g, '')}-${weight}${ext}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, fontData);
    } catch(saveErr) {
      log.warn(`[FONTS] Não foi possível salvar ${family}: ${saveErr.message}`);
    }
  } catch(e) {
    log.warn(`[FONTS] Falha ao carregar ${family} ${weight}: ${e.message}`);
  }
}

// Inicializa o cache em background (não bloqueia o startup)
function initFontCache() {
  Promise.allSettled(DESIGN_FONTS.map(f => _loadOneFont(f.family, f.weight)))
    .then(() => {
      log.info(`[FONTS] Cache: ${_fontCache.size}/${DESIGN_FONTS.length} fontes prontas`);
      // Atualiza fontconfig para que librsvg encontre as fontes pelo nome da família
      try {
        const { execSync } = require('child_process');
        execSync(`fc-cache -f "${_fontsDir}"`, { timeout: 15000, stdio: 'ignore' });
        log.info('[FONTS] fontconfig atualizado — fontes disponíveis para rasterização');
      } catch(fcErr) {
        log.warn('[FONTS] fc-cache falhou:', fcErr.message);
      }
    });
}

// Gera o bloco @font-face CSS com as fontes em base64
function _buildFontFaceCSS() {
  return [..._fontCache.entries()].map(([key, { b64, fmt }]) => {
    const [family, weight] = key.split(':');
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;` +
           `src:url('data:font/${fmt};base64,${b64}') format('${fmt}');}`;
  }).join('');
}

// Injeta @font-face no SVG para que a rasterização use as fontes corretas
function injectFontsIntoSvg(svg) {
  const css = _buildFontFaceCSS();
  if (!css) return svg; // sem cache ainda — rasteriza com fontes do sistema
  const defs = `<defs><style>${css}</style></defs>`;
  // Insere logo após a tag de abertura <svg ...>
  return svg.replace(/(<svg[^>]*>)/, `$1${defs}`);
}

// ─────────────────────────────────────────────
// HTTP UTILS
// ─────────────────────────────────────────────

const _routes = [];

function route(method, pattern, handler) {
  _routes.push({ method, pattern, handler, rx: pathToRx(pattern) });
}

function pathToRx(p) {
  const rx = p.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)');
  return new RegExp('^' + rx + '(?:\\?.*)?$');
}

function matchRoute(method, url) {
  const urlPath = url.split('?')[0];
  for (const r of _routes) {
    if (r.method !== method) continue;
    const m = urlPath.match(r.rx);
    if (m) return { handler: r.handler, params: m.groups || {} };
  }
  return null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (ALLOWED_ORIGIN !== '*') res.setHeader('Vary', 'Origin');
}

function json(res, data, status = 200) {
  cors(res);
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function ok(res, data, status = 200)     { json(res, { ok: true, ...data }, status); }
function err(res, msg, status = 400)     { json(res, { ok: false, error: msg }, status); }

// ── JWT ──
const JWT = {
  sign(payload) {
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
    const body   = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 86400000 })).toString('base64url');
    const sig    = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  },
  verify(token) {
    try {
      const [h, b, s] = token.split('.');
      const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
      if (s !== expected) return null;
      const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
      if (payload.exp < Date.now()) return null;
      return payload;
    } catch { return null; }
  }
};

function requireAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) { err(res, 'Token obrigatório', 401); return null; }
  const payload = JWT.verify(token);
  if (!payload) { err(res, 'Token inválido ou expirado', 401); return null; }
  return payload;
}

function requireAdmin(req, res) {
  const payload = requireAuth(req, res);
  if (!payload) return null;
  if (payload.role !== 'admin') { err(res, 'Acesso negado', 403); return null; }
  return payload;
}

// ─────────────────────────────────────────────
// RATE LIMITER — proteção contra força bruta (SQLite)
// ─────────────────────────────────────────────
// Delegado ao Database.loginRateCheck / loginRateClear para sobreviver a restarts.

// ─────────────────────────────────────────────
// ROUTES — AUTH (preservados do v12)
// ─────────────────────────────────────────────

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

  // Rate limiting por e-mail (persistido em SQLite)
  const rlKey = 'login:' + (email || '').toLowerCase().trim();
  const rl = db.loginRateCheck(rlKey);
  if (rl.blocked) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return err(res, `Muitas tentativas. Tente novamente em ${Math.ceil(rl.retryAfter / 60)} minutos.`, 429);
  }

  let user;
  try { user = db.verifyPassword(email, password); }
  catch (e) {
    if (e.message === 'BCRYPT_LEGACY')
      return err(res, 'Sua conta usa um formato de senha antigo. Redefina sua senha para continuar.', 401);
    return err(res, 'Erro interno ao verificar senha', 500);
  }
  if (!user) return err(res, 'E-mail ou senha incorretos', 401);

  // Login OK — resetar contador
  db.loginRateClear(rlKey);
  const token = JWT.sign({ id: user.id, email: user.email, role: user.role });
  ok(res, { user, token });
});

route('GET', '/api/auth/me', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const user = db.getUserById(payload.id);
  if (!user) return err(res, 'Usuário não encontrado', 404);
  ok(res, { user });
});

// ─────────────────────────────────────────────
// ROUTES — USER
// ─────────────────────────────────────────────

route('PUT', '/api/user/profile', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  const allowed = ['name','email','password','profissao','nicho','publico','tom','cores','estilo','redes','onboard_step'];
  const fields = {};
  allowed.forEach(k => { if (body[k] !== undefined) fields[k] = body[k]; });
  try { const user = db.updateUser(payload.id, fields); ok(res, { user }); }
  catch (e) { err(res, e.message); }
});

// BLOCO 4 — Onboarding step-by-step (salva progresso incrementalmente)
route('POST', '/api/user/onboard-step', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  const { step, data: stepData } = body;
  if (!step) return err(res, 'step obrigatório');

  const stepNum = parseInt(step, 10);
  if (isNaN(stepNum) || stepNum < 1 || stepNum > 7) return err(res, 'step inválido (1-7)');

  // Validadores por campo
  const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
  const CORES_RE  = /^#[0-9A-Fa-f]{6},\s*#[0-9A-Fa-f]{6}$/;
  const MAX_LEN   = { profissao:100, nicho:100, publico:200, tom:80, estilo:100, redes:200 };
  const VALID_TOMS = ['autoridade','educativo','inspirador','descontraído','provocativo','empático'];
  const VALID_ESTILOS = ['dark luxury','minimalista','colorido','editorial','corporativo','criativo'];

  function sanitizeStr(val, field) {
    if (typeof val !== 'string') return null;
    const trimmed = val.trim().slice(0, MAX_LEN[field] || 200);
    // remove tags HTML básicas
    return trimmed.replace(/<[^>]*>/g, '');
  }

  // Mapa de step para fields do usuário
  const stepFields = { onboard_step: stepNum };
  const fieldMap = {
    1: ['profissao'],
    2: ['nicho', 'publico'],
    3: ['tom'],
    4: ['cores'],
    5: ['estilo'],
    6: ['redes'],
    7: ['profissao','nicho','publico','tom','cores','estilo','redes']
  };

  if (stepData && fieldMap[stepNum]) {
    for (const k of fieldMap[stepNum]) {
      const val = stepData[k];
      if (val === undefined) continue;

      if (k === 'cores') {
        // Aceita "cor1, cor2" ou apenas "cor1"
        const normalized = String(val).trim();
        if (!CORES_RE.test(normalized) && !HEX_COLOR.test(normalized.split(',')[0].trim()))
          return err(res, `cores inválidas. Use formato "#RRGGBB, #RRGGBB"`);
        stepFields[k] = normalized;
      } else {
        const clean = sanitizeStr(val, k);
        if (clean === null) return err(res, `${k} deve ser texto`);
        stepFields[k] = clean;
      }
    }
  }

  try {
    const user = db.updateUser(payload.id, stepFields);
    ok(res, { user, step: stepNum });
  } catch (e) { err(res, e.message); }
});

route('GET', '/api/user/generations', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  ok(res, { generations: db.getGenerations({ user_id: payload.id, limit: 50 }) });
});

// ─────────────────────────────────────────────
// ROUTES — CALENDAR (BLOCO 3 — novo)
// ─────────────────────────────────────────────

route('GET', '/api/user/calendar', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const url = new URL('http://x' + req.url);
  const month = parseInt(url.searchParams.get('month') || '0');
  const year  = parseInt(url.searchParams.get('year')  || '0');
  const posts = db.getCalendarPosts({ user_id: payload.id, month: month || undefined, year: year || undefined });
  const stats = db.getCalendarStats(payload.id);
  ok(res, { posts, stats });
});

route('POST', '/api/user/calendar', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  if (!body.title) return err(res, 'title obrigatório');
  try {
    const post = db.createCalendarPost({ user_id: payload.id, ...body });
    ok(res, { post }, 201);
  } catch (e) { err(res, e.message); }
});

route('PATCH', '/api/user/calendar/:id', async (req, res, params) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  try {
    const post = db.updateCalendarPost(params.id, payload.id, body);
    ok(res, { post });
  } catch (e) { err(res, e.message); }
});

route('DELETE', '/api/user/calendar/:id', async (req, res, params) => {
  const payload = requireAuth(req, res); if (!payload) return;
  try {
    db.deleteCalendarPost(params.id, payload.id);
    ok(res, { message: 'Post removido do calendário' });
  } catch (e) { err(res, e.message); }
});

// ─────────────────────────────────────────────
// ROUTES — GENERATE (preservados + streaming)
// ─────────────────────────────────────────────

route('POST', '/api/user/refine-prompt', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  const { input, format, network, refImageBase64, modelSvg, modelN, modelName, brandPalette, slideCount } = body;
  if (!input) return err(res, 'input obrigatorio');
  const user = db.getUserById(payload.id);
  const memory = db.getMemory(payload.id);
  const memCtx = buildMemoryContext(memory);
  const refineOpts = { modelSvg, modelN, modelName, brandPalette };
  try {
    const isCarrossel = (format === 'carrossel');
    const nSlides = parseInt(slideCount) || 0;
    const carrosselCtx = isCarrossel
      ? ('\n\nFORMATO: CARROSSEL' + (nSlides > 0 ? ' de ' + nSlides + ' slides' : ' (quantidade a ser definida, entre 3 e 7 slides)') + '.\nEstruture o conteudo como arco narrativo: CAPA (gancho impactante) → DESENVOLVIMENTO (uma ideia por slide) → FECHAMENTO (CTA forte). Indique claramente o que vai em cada slide.')
      : '';
    const userMsg = modelN
      ? ('Input bruto: "' + input + '"\n\nModelo selecionado: ' + modelN + ' — ' + modelName + '\nExpanda com narrativa e dados reais.' + carrosselCtx + '\nRetorne apenas o prompt refinado:')
      : ('Input bruto: "' + input + '"\n\nExpanda o conteudo, a narrativa e os dados.' + carrosselCtx + '\nRetorne apenas o prompt refinado:');
    let messages;
    if (refImageBase64) {
      messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: refImageBase64 } }, { type: 'text', text: userMsg }] }];
    } else {
      messages = [{ role: 'user', content: userMsg }];
    }
    const { text: refined } = await callClaudeMessages({ system: getRefineSkill(user, refineOpts) + memCtx, messages, maxTokens: 600 });
    ok(res, { refined_prompt: refined.trim(), original: input });
  } catch(e) {
    const p = user || {};
    ok(res, { refined_prompt: input + ' — contexto: ' + (p.nicho || 'negocios') + ', tom ' + (p.tom || 'autoridade') + ', publico ' + (p.publico || 'profissionais'), original: input });
  }
});

route('POST', '/api/user/generate', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { format, network, input } = await parseBody(req);
  if (!format || !network || !input) return err(res, 'format, network e input obrigatórios');
  const user = db.getUserById(payload.id);
  try { db.consumeQuota(payload.id); } catch(e) { return err(res, e.message); }
  let concepts;
  try {
    const { text: rawConcepts } = await callClaude({
      system: getConceptsSkill(user),
      userMsg: `Formato: ${format}\nRede: ${network}\nIdeia: "${input}"\n\nGere os 3 conceitos em JSON:`,
      maxTokens: 1500
    });
    const jsonMatch = rawConcepts.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('JSON inválido');
    concepts = JSON.parse(jsonMatch[0]);
  } catch {
    concepts = [
      { name:'O Confronto', approach:`Abordagem direta para "${input.slice(0,40)}..."`, emotion:'Autoridade + reconhecimento', prompt:`dramatic editorial photography, ${input.slice(0,60)}, deep dark background, ${user?.cores||'#F36B2A'} accent lighting, rule of thirds, no text, no watermark` },
      { name:'A Virada', approach:`Abordagem conceitual para "${input.slice(0,40)}..."`, emotion:'Urgência + clareza', prompt:`CGI 3D cinematic render, ${input.slice(0,60)}, dark luxury aesthetic, golden accent, professional composition, no text, no watermark` },
      { name:'O Resultado', approach:`Abordagem emocional para "${input.slice(0,40)}..."`, emotion:'Insight + impacto', prompt:`cinematic portrait, ${input.slice(0,60)}, dramatic rim lighting, ${user?.cores||'#F36B2A'} backlight, editorial style, no text, no watermark` }
    ];
  }
  const gen = db.addGeneration({ user_id:payload.id, feature:'imagem', format, network, concept_name:concepts[0].name, prompt:concepts[0].prompt, credits_used:1 });
  ok(res, { generation:gen, concepts });
});

// BLOCO 1 — STREAMING: /api/user/generate-content-stream
route('POST', '/api/user/generate-content-stream', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { agent, input, tom, tipo, rede, mediaFiles } = await parseBody(req);
  if (!agent || !input) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'agent e input obrigatorios' }));
  }
  const user   = db.getUserById(payload.id);
  const memory = db.getMemory(payload.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
  const send = function(type, data) {
    const obj = Object.assign({ type: type }, data);
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };
  try {
    try { db.consumeQuota(payload.id); } catch(e) { send('error', { message: e.message }); return res.end(); }

    send('stage', { stage: 1, label: 'Estrategista analisando...' });

    var tom2      = tom || (user && user.tom) || 'autoridade';
    var nicho     = (user && user.nicho)     || 'negocios';
    var profissao = (user && user.profissao) || 'criador de conteudo';
    var publico   = (user && user.publico)   || 'profissionais';
    var memCtx    = buildMemoryContext(memory);

    var sysStrategist = 'Voce e o ESTRATEGISTA do AutoPostt.\nPERFIL: profissao=' + profissao + ' | nicho=' + nicho + ' | tom=' + tom2 + ' | publico=' + publico + memCtx + '\n\nEntregue SEM introducoes:\nANGULO: [angulo unico]\nGANCHO: [primeira linha, max 10 palavras]\nESTRUTURA: [como organizar]\nTOM_ESPECIFICO: [nuances de tom]\nEVITAR: [o que nao fazer]';

    const stratResult = await callClaude({ system: sysStrategist, userMsg: 'INPUT: "' + input + '"\nAGENTE: ' + agent + '\n\nDefina a estrategia:', maxTokens: 400 });
    const brief = stratResult.text;
    let streamInputTokens = stratResult.inputTokens || 0;
    let streamOutputTokens = stratResult.outputTokens || 0;

    send('stage', { stage: 2, label: 'Copywriter escrevendo...' });

    var sysCopywriter = 'Voce e o COPYWRITER do AutoPostt.\nPERFIL: profissao=' + profissao + ' | nicho=' + nicho + ' | tom=' + tom2 + ' | publico=' + publico + memCtx + '\n\nBRIEFING ESTRATEGICO:\n' + brief + '\n\nREGRA: Entregue APENAS o conteudo final. Zero introducoes.';
    var agentStructure = getAgentStructure(agent);
    var userContent = 'INPUT ORIGINAL: "' + input + '"\n\n' + agentStructure;
    var messages;
    if (mediaFiles && mediaFiles.length) {
      var parts = [];
      mediaFiles.slice(0, 3).forEach(function(mf) {
        if (mf.isVideo) parts.push({ type: 'text', text: '[MIDIA: "' + mf.name + '"]' });
        else parts.push({ type: 'image', source: { type: 'base64', media_type: mf.mime || 'image/jpeg', data: mf.base64 } });
      });
      parts.push({ type: 'text', text: userContent });
      messages = [{ role: 'user', content: parts }];
    } else {
      messages = [{ role: 'user', content: userContent }];
    }

    const bodyStr = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2500, system: sysCopywriter, messages: messages, stream: true });
    await new Promise(function(resolve, reject) {
      const opts = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(bodyStr) }
      };
      const req2 = https.request(opts, function(apiRes) {
        let buf = '';
        apiRes.on('data', function(chunk) {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function(line) {
            if (!line.startsWith('data: ')) return;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') return;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
                send('delta', { text: evt.delta.text });
              }
              if (evt.type === 'message_start' && evt.message?.usage) {
                streamInputTokens += evt.message.usage.input_tokens || 0;
              }
              if (evt.type === 'message_delta' && evt.usage) {
                streamOutputTokens += evt.usage.output_tokens || 0;
              }
            } catch(e) {}
          });
        });
        apiRes.on('end', resolve);
        apiRes.on('error', reject);
      });
      req2.on('error', reject);
      req2.write(bodyStr);
      req2.end();
    });

    send('done', { agent: agent, rede: rede, tipo: tipo });
    res.end();

    db.addGeneration({ user_id: payload.id, feature: agent, format: tipo || agent, network: rede || 'instagram', concept_name: agent, prompt: input.slice(0, 200), credits_used: 1, input_tokens: streamInputTokens, output_tokens: streamOutputTokens });
    const newCount = db.upsertMemory(payload.id, { summary: memory.summary, preferences: memory.preferences, positive: memory.positive, negative: memory.negative, incrementGen: true });
    if (newCount % 5 === 0) {
      const recentGens = db.getRecentGenerations(payload.id, 15);
      maybeSummarizeMemory(payload.id, newCount, recentGens).catch(function() {});
    }
  } catch(e) { send('error', { message: e.message }); res.end(); }
});

// BLOCO 1 — Non-streaming (preservado para compatibilidade)
route('POST', '/api/user/generate-content', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { agent, input, tom, tipo, rede, mediaFiles } = await parseBody(req);
  if (!agent || !input) return err(res, 'agent e input obrigatorios');
  const user = db.getUserById(payload.id);
  try { db.consumeQuota(payload.id); } catch(e) { return err(res, e.message); }
  const memory = db.getMemory(payload.id);
  try {
    const { content: responseText, inputTokens: agentIn, outputTokens: agentOut } = await runAgentPipeline({ agent, input, user, memory, tomOverride: tom, mediaFiles });
    db.addGeneration({ user_id: payload.id, feature: agent, format: tipo || agent, network: rede || 'instagram', concept_name: agent, prompt: input.slice(0, 200), credits_used: 1, input_tokens: agentIn || 0, output_tokens: agentOut || 0 });
    const newCount = db.upsertMemory(payload.id, { summary: memory.summary, preferences: memory.preferences, positive: memory.positive, negative: memory.negative, incrementGen: true });
    if (newCount % 5 === 0) {
      const recentGens = db.getRecentGenerations(payload.id, 15);
      maybeSummarizeMemory(payload.id, newCount, recentGens).catch(function() {});
    }
    ok(res, { content: responseText, agent, rede, tipo });
  } catch (e) { err(res, e.message); }
});

route('POST', '/api/user/generate-image', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const body = await parseBody(req);
  const { prompt, format, network, brandProfile, slideIndex, totalSlides, isCarrossel } = body;
  if (!prompt) return err(res, 'prompt obrigatorio');
  const user = db.getUserById(payload.id);
  try { db.consumeQuota(payload.id); } catch(e) { return err(res, e.message); }

  const bp = brandProfile && brandProfile.brandPalette;
  const rawCores = ((brandProfile && brandProfile.cores) || user.cores || '#F5C518,#0D0D0F,#F5F4F0,#888888').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  const brandPrimaria    = (bp && bp.primaria)    || rawCores[0] || '#F5C518';
  const brandSecundaria  = (bp && bp.secundaria)  || rawCores[1] || '#0D0D0F';
  const brandTerciaria   = (bp && bp.terciaria)   || rawCores[2] || '#F5F4F0';
  const brandQuaternaria = (bp && bp.quaternaria) || rawCores[3] || '#888888';
  const nicho     = (brandProfile && brandProfile.nicho)     || user.nicho     || 'negocios';
  const profissao = (brandProfile && brandProfile.profissao) || user.profissao || 'criador de conteudo';
  const estilo    = (brandProfile && brandProfile.estilo)    || user.estilo    || 'moderno';
  const tom       = (brandProfile && brandProfile.tom)       || user.tom       || 'autoridade';
  const publico   = (brandProfile && brandProfile.publico)   || user.publico   || 'profissionais';
  const modelN    = (brandProfile && brandProfile.modelN)    || '';
  const modelName = (brandProfile && brandProfile.modelName) || '';

  const dim = (format === 'story' || format === 'reels') ? { w: 1080, h: 1920 }
    : format === 'thumb'  ? { w: 1280, h: 720  }
    : format === 'banner' ? { w: 1584, h: 396  }
    : { w: 1080, h: 1080 };

  const styleDNA = modelN ? (STYLE_DNA[modelN] || '') : '';
  const fmtLabel = ({ post:'Post', carrossel:'Carrossel', anuncio:'Anuncio', story:'Story', reels:'Reels', thumb:'Thumbnail', banner:'Banner' })[format] || 'Post';
  const netLabel = ({ instagram:'Instagram', linkedin:'LinkedIn', youtube:'YouTube', tiktok:'TikTok', facebook:'Facebook' })[network] || 'Instagram';

  let resolvedTotal = totalSlides || null;
  if (isCarrossel && slideIndex === 1 && !totalSlides) resolvedTotal = 5;
  if (!resolvedTotal) resolvedTotal = 1;

  const systemPrompt = 'Voce e o DESIGN AGENT do AutoPostt — especialista em criar posts para redes sociais em SVG do zero.\n\n' +
    'REGRAS INVIOLAVEIS:\n' +
    '1. Retorne SOMENTE o SVG. Comece com <svg.\n' +
    '2. Use xmlns="http://www.w3.org/2000/svg" na tag raiz.\n' +
    '3. NUNCA use <image> com href externo.\n' +
    '4. NUNCA use @import. Declare font-family nos atributos.\n' +
    '5. Todo SVG deve ter viewBox declarado.\n\n' +
    'FONTES: "DM Sans",sans-serif | "IBM Plex Mono",monospace | "Playfair Display",serif | "Cormorant Garamond",serif | "Syne",sans-serif | "Bebas Neue",sans-serif\n\n' +
    'ESTRUTURA: 1.GANCHO(headline grande) 2.DESENVOLVIMENTO(informacao real) 3.CTA(direto) 4.IDENTIDADE(@handle no rodape)';

  let userPrompt;
  if (isCarrossel) {
    const slideRole = slideIndex === 1
      ? 'SLIDE 1 DE ' + resolvedTotal + ' — CAPA: mais impactante, para o scroll, promessa clara do que vem.'
      : slideIndex === resolvedTotal
      ? 'SLIDE ' + slideIndex + ' DE ' + resolvedTotal + ' — FECHAMENTO: fecha narrativa, CTA forte e direto.'
      : 'SLIDE ' + slideIndex + ' DE ' + resolvedTotal + ' — DESENVOLVIMENTO: UMA ideia especifica, aprofunda o tema.';
    userPrompt = 'CARROSSEL: "' + prompt + '"\n' + slideRole + '\nFORMATO: Carrossel para ' + netLabel + '\nDIMENSOES: ' + dim.w + 'x' + dim.h + 'px viewBox="0 0 ' + dim.w + ' ' + dim.h + '"\n' +
      'MARCA: ' + profissao + ' | nicho: ' + nicho + ' | tom: ' + tom + ' | publico: ' + publico + '\n' +
      'PALETA: primaria=' + brandPrimaria + ' secundaria=' + brandSecundaria + ' terciaria=' + brandTerciaria + ' quaternaria=' + brandQuaternaria + '\n' +
      (styleDNA ? 'ESTILO REF (' + modelN + '): ' + styleDNA + '\n' : '') +
      'REGRAS: fundo rect cobrindo viewBox com cor secundaria. Consistencia entre slides. Margem 60-80px. Mostre "' + slideIndex + '/' + resolvedTotal + '" no canto. Textos 100% reais sobre o tema.\nComece com <svg:';
  } else {
    userPrompt = 'BRIEF: "' + prompt + '"\nFORMATO: ' + fmtLabel + ' para ' + netLabel + '\nDIMENSOES: ' + dim.w + 'x' + dim.h + 'px viewBox="0 0 ' + dim.w + ' ' + dim.h + '"\n' +
      'MARCA: ' + profissao + ' | nicho: ' + nicho + ' | tom: ' + tom + ' | publico: ' + publico + ' | estilo: ' + estilo + '\n' +
      'PALETA: primaria=' + brandPrimaria + ' secundaria=' + brandSecundaria + ' terciaria=' + brandTerciaria + ' quaternaria=' + brandQuaternaria + '\n' +
      (styleDNA ? 'ESTILO REF (' + modelN + '): ' + styleDNA + '\n' : '') +
      'REGRAS: rect fundo cor secundaria. Primaria para acentos. Terciaria texto principal. Margem 60-80px. Hierarquia headline 80-140px. Elemento geometrico de destaque. Textos 100% reais.\nComece com <svg:';
  }

  try {
    const result = await callClaude({ system: systemPrompt, userMsg: userPrompt, maxTokens: 8000 });
    let finalSvg = '';
    const svgMatch = result.text.match(/<svg[\s\S]*<\/svg>/i);
    if (svgMatch) finalSvg = svgMatch[0];
    else if (result.text.trim().startsWith('<svg')) finalSvg = result.text.trim();
    if (!finalSvg.includes('xmlns=')) finalSvg = finalSvg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    if (!finalSvg.includes('viewBox')) finalSvg = finalSvg.replace('<svg', '<svg viewBox="0 0 ' + dim.w + ' ' + dim.h + '"');
    if (!finalSvg || finalSvg.length < 200) throw new Error('SVG invalido. Tente novamente.');
    finalSvg = sanitizeSvg(finalSvg);

    db.addGeneration({ user_id: payload.id, feature: isCarrossel ? 'carrossel-slide' : 'gerar-imagem', format: format || 'post', network: network || 'instagram', concept_name: (modelName || prompt).slice(0, 60), prompt: prompt.slice(0, 200), svg_data: finalSvg, credits_used: 1, input_tokens: result.inputTokens, output_tokens: result.outputTokens });

    const responsePayload = { svg: finalSvg };
    if (isCarrossel && slideIndex === 1) responsePayload.totalSlides = resolvedTotal;
    ok(res, responsePayload);
  } catch(e) { err(res, e.message); }
});

// ─────────────────────────────────────────────
// ROUTES — ADMIN (preservados do v12)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// CÂMBIO USD/BRL — AwesomeAPI + BCB PTAX (fallback)
// ─────────────────────────────────────────────

let _fxCache = { rate: 5.20, source: 'fallback', pctChange: '0', high: 0, low: 0, updatedAt: null };

function _fxRequest(opts, cb) {
  const req = https.request(opts, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { cb(null, JSON.parse(d)); } catch(e) { cb(e); } });
  });
  req.on('error', cb);
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.setTimeout(6000);
  req.end();
}

function fetchAwesome() {
  return new Promise(resolve => {
    _fxRequest({
      hostname: 'economia.awesomeapi.com.br',
      path: '/json/last/USD-BRL',
      method: 'GET',
      headers: { 'User-Agent': 'AutoPostt/1.0' }
    }, (err, p) => {
      if (err || !p?.USDBRL?.bid) return resolve(null);
      const rate = parseFloat(p.USDBRL.bid);
      if (!rate || rate < 1) return resolve(null);
      resolve({
        rate:       parseFloat(rate.toFixed(4)),
        source:     'AwesomeAPI',
        pctChange:  p.USDBRL.pctChange || '0',
        high:       parseFloat(p.USDBRL.high || 0),
        low:        parseFloat(p.USDBRL.low  || 0),
        updatedAt:  new Date().toISOString()
      });
    });
  });
}

function fetchBcb() {
  return new Promise(resolve => {
    const d    = new Date();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    _fxRequest({
      hostname: 'olinda.bcb.gov.br',
      path:     `/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${mm}-${dd}-${yyyy}'&$format=json&$select=cotacaoVenda`,
      method:   'GET',
      headers:  { Accept: 'application/json' }
    }, (err, p) => {
      if (err) return resolve(null);
      const rate = p?.value?.[0]?.cotacaoVenda;
      if (!rate || rate < 1) return resolve(null);
      resolve({ rate: parseFloat(rate.toFixed(4)), source: 'BCB-PTAX', pctChange: '0', high: 0, low: 0, updatedAt: new Date().toISOString() });
    });
  });
}

async function getExchangeRate() {
  if (_fxCache.updatedAt && (Date.now() - new Date(_fxCache.updatedAt).getTime()) < 10 * 60 * 1000) {
    return _fxCache;
  }
  const result = (await fetchAwesome()) || (await fetchBcb());
  if (result) _fxCache = result;
  return _fxCache;
}

route('POST', '/api/user/feedback', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { generation_id, rating, positive_note, negative_note, note } = await parseBody(req);
  if (!generation_id || rating === undefined) return err(res, 'generation_id e rating obrigatorios');
  try {
    db.addFeedback(payload.id, generation_id, rating, note || '');
    const memory = db.getMemory(payload.id);
    const positive = (memory.positive || []).slice();
    const negative = (memory.negative || []).slice();
    if (rating >= 1 && positive_note) { positive.push(positive_note); if (positive.length > 20) positive.shift(); }
    if (rating <= -1 && negative_note) { negative.push(negative_note); if (negative.length > 20) negative.shift(); }
    db.upsertMemory(payload.id, { summary: memory.summary, preferences: memory.preferences, positive: positive, negative: negative, incrementGen: false });
    ok(res, { ok: true });
  } catch(e) { err(res, e.message); }
});

route('GET', '/api/user/memory', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  ok(res, { memory: db.getMemory(payload.id) });
});

route('GET', '/api/admin/exchange-rate', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try {
    const fx = await getExchangeRate();
    ok(res, { exchange: fx });
  } catch(e) { err(res, e.message); }
});

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
  catch (e) { err(res, e.message); }
});

route('PATCH', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const user = db.updateUser(params.id, body); ok(res, { user }); }
  catch (e) { err(res, e.message); }
});

route('DELETE', '/api/admin/users/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try { db.deleteUser(params.id); ok(res, { message: 'Usuário removido' }); }
  catch (e) { err(res, e.message); }
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

route('POST', '/api/admin/plans', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const plan = db.createPlan(body); ok(res, { plan }, 201); }
  catch (e) { err(res, e.message); }
});

route('PATCH', '/api/admin/plans/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const plan = db.updatePlan(params.id, body); ok(res, { plan }); }
  catch (e) { err(res, e.message); }
});

route('DELETE', '/api/admin/plans/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try { db.deletePlan(params.id); ok(res, { message: 'Plano removido' }); }
  catch (e) { err(res, e.message); }
});

route('GET', '/api/admin/packages', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  ok(res, { packages: db.getPackages() });
});

route('POST', '/api/admin/packages', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const pkg = db.createPackage(body); ok(res, { package: pkg }, 201); }
  catch (e) { err(res, e.message); }
});

route('PATCH', '/api/admin/packages/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const body = await parseBody(req);
  try { const pkg = db.updatePackage(params.id, body); ok(res, { package: pkg }); }
  catch (e) { err(res, e.message); }
});

route('DELETE', '/api/admin/packages/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  try { db.deletePackage(params.id); ok(res, { message: 'Pacote removido' }); }
  catch (e) { err(res, e.message); }
});

route('POST', '/api/user/apply-package', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { package_id } = await parseBody(req);
  if (!package_id) return err(res, 'package_id obrigatório');
  try {
    const user = db.applyPackage(payload.id, package_id);
    ok(res, { user, message: 'Pacote aplicado! Créditos adicionados.' });
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

route('GET', '/api/admin/cost-report', async (req, res) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const gens = db.getGenerationsWithUsers({ limit: 1000 });
  const report = gens.map(g => ({
    id: g.id, feature: g.feature || g.format || 'unknown',
    user_name: g.user_name || '?', user_email: g.user_email || '',
    input_tokens: g.input_tokens || 0, output_tokens: g.output_tokens || 0,
    total_tokens: g.total_tokens || 0, cost_usd: parseFloat((g.cost_usd || 0).toFixed(6)),
    credits_used: g.credits_used || 1, created_at: g.created_at
  }));
  ok(res, { report, total: report.length });
});

route('GET', '/api/admin/user-stats/:id', async (req, res, params) => {
  const payload = requireAdmin(req, res); if (!payload) return;
  const gens = db.getGenerations({ user_id: params.id, limit: 1000 });
  const totalCost    = gens.reduce((s,g) => s+(g.cost_usd||0), 0);
  const totalCredits = gens.reduce((s,g) => s+(g.credits_used||1), 0);
  const byFeature = {};
  gens.forEach(g => { const f=g.feature||g.format||'unknown'; if(!byFeature[f])byFeature[f]=0; byFeature[f]++; });
  ok(res, { user_id:params.id, total_generations:gens.length, total_cost_usd:parseFloat(totalCost.toFixed(6)), total_credits:totalCredits, by_feature:byFeature });
});

route('GET', '/api/plans', async (req, res) => {
  ok(res, { plans: db.getPlans(), packages: db.getPackages().filter(p => p.active) });
});

// ═════════════════════════════════════════════════════════════════════════════
// DESIGN AGENT — Coração da plataforma de criação visual
//
// Pipeline 3 estágios (cada um alimenta o próximo com dados estruturados):
//   Estágio 1 · Brief Analyst   → extrai hierarquia de conteúdo (JSON)
//   Estágio 2 · Art Director    → define blueprint de design com coords precisas (JSON)
//   Estágio 3 · SVG Executor    → gera SVG profissional seguindo o blueprint
//
// Rotas:
//   POST /api/user/design-agent               → SSE, gera 1 imagem/slide
//   POST /api/user/design-agent/plan-carousel → JSON, planeja narrativa completa
// ═════════════════════════════════════════════════════════════════════════════

const DA_DIMS = {
  post:      { w: 1080, h: 1080 },
  carrossel: { w: 1080, h: 1080 },
  story:     { w: 1080, h: 1920 },
  reels:     { w: 1080, h: 1920 },
  thumb:     { w: 1280, h: 720  },
  banner:    { w: 1584, h: 396  },
  anuncio:   { w: 1080, h: 1080 },
};

const DA_NET_LABELS = {
  instagram: 'Instagram', linkedin: 'LinkedIn',
  youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook',
};

// Normaliza dados da marca em um objeto único
function daBrand(user, bp) {
  const bpal = bp?.brandPalette;
  const raw  = ((bp?.cores) || user?.cores || '#F5C518,#0D0D0F,#F5F4F0,#888888')
    .split(',').map(s => s.trim()).filter(Boolean);
  const profissao = bp?.profissao || user?.profissao || 'criador de conteúdo';
  // Nome real do usuário (conta) tem prioridade sobre profissao
  const nome = (bp?.userName || user?.name || profissao).slice(0, 40);
  // Handle para tweet card: "PrimeiroNome | Profissao/Empresa"
  const firstName = nome.split(' ')[0];
  const empresa   = profissao.slice(0, 20);
  const tweetHandle = firstName + ' | ' + empresa;
  return {
    p1: bpal?.primaria    || raw[0] || '#F5C518',
    p2: bpal?.secundaria  || raw[1] || '#0D0D0F',
    p3: bpal?.terciaria   || raw[2] || '#F5F4F0',
    p4: bpal?.quaternaria || raw[3] || '#888888',
    nicho:     bp?.nicho     || user?.nicho     || 'negócios',
    profissao,
    estilo:    bp?.estilo    || user?.estilo    || 'dark luxury',
    tom:       bp?.tom       || user?.tom       || 'autoridade',
    publico:   bp?.publico   || user?.publico   || 'profissionais',
    handle:    bp?.handle    || ('@' + profissao.toLowerCase().replace(/\s+/g, '').slice(0, 15)),
    nome,
    tweetHandle,
    logo:      bp?.logoData  || null,           // base64 data URI da logo do usuário
    voiceId:   bp?.voiceId   || '',
    voiceName: bp?.voiceName || '',
    modelN:    bp?.modelN    || '',
    modelName: bp?.modelName || '',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYOUT TEMPLATES — catálogo de modelos visuais por formato e rede social
// Cada template define zonas como fração do canvas (0.0→1.0) + regras de decoração.
// resolveLayout() converte para px absolutos — Stage 3 só cria decoração visual.
// ═══════════════════════════════════════════════════════════════════════════════
const LAYOUT_TEMPLATES = {

  // ─── POST ÚNICO 1080×1080 ─────────────────────────────────────────────────

  'IG-POST-IMPACTO': {
    name: 'Impacto Tipográfico',
    desc: 'Tipografia como herói — afirmações polêmicas e autoridade direta',
    formats: ['post','anuncio'], networks: ['ig','li'],
    content_types: ['motivational','educational','storytelling'],
    hl:  { xf:0.07, yf:0.42, sf:0.130, lhm:1.14, anchor:'start', transform:'uppercase' },
    sub: { xf:0.07, ybl:0.065, sf:0.028, w:'400' },
    body: null, cta: null,
    ft:  { xf:0.07, yf:0.95, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'noise',
    deco: { mood:'minimal-power',
      layers:['radial-glow-center','noise-texture','accent-rule-left','corner-brackets'],
      has_gradient:true, has_glow:true, has_pattern:true, shape_count:3 },
  },

  'IG-POST-DADO': {
    name: 'Número Hero',
    desc: 'Estatística ou dado como elemento visual principal — alta prova social',
    formats: ['post'], networks: ['ig','li'],
    content_types: ['data-driven','promotional'],
    hl:  { xf:0.07, yf:0.74, sf:0.065, lhm:1.18, anchor:'start' },
    sub: { xf:0.07, ybl:0.050, sf:0.028, w:'400' },
    body: null,
    cta: { xf:0.07, yf:0.88 },
    ft:  { xf:0.07, yf:0.96, sf:0.017 },
    db:  { xf:0.50, yf:0.44, sf:0.240, anchor:'middle', font:'Bebas Neue' },
    bg_pref: 'dark', texture: 'grid-micro',
    deco: { mood:'data-hero',
      layers:['radial-glow-center','grid-pattern','accent-circle-bg','separator-h'],
      has_gradient:true, has_glow:true, has_pattern:true, shape_count:4 },
  },

  'IG-POST-LISTA': {
    name: 'Lista Educacional',
    desc: 'Conteúdo escaneável — máxima retenção e compartilhamento',
    formats: ['post'], networks: ['ig','li'],
    content_types: ['educational'],
    hl:  { xf:0.07, yf:0.20, sf:0.078, lhm:1.15, anchor:'start' },
    sub: null,
    body:{ xf:0.07, ysf:0.34, sf:0.027, lhm:1.85, prefix:'→' },
    cta: null,
    ft:  { xf:0.07, yf:0.95, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'subtle',
    deco: { mood:'clean-list',
      layers:['accent-rule-top','separator-h-after-hl','subtle-glow-top'],
      has_gradient:true, has_glow:false, has_pattern:false, shape_count:2 },
  },

  'IG-POST-EDITORIAL': {
    name: 'Editorial Premium',
    desc: 'Estética de revista — autoridade para nichos premium e consultoria',
    formats: ['post'], networks: ['ig','li'],
    content_types: ['educational','storytelling','motivational'],
    hl:  { xf:0.08, yf:0.50, sf:0.088, lhm:1.20, anchor:'start', font:'Playfair Display' },
    sub: { xf:0.08, ybl:0.065, sf:0.026, w:'300', font:'DM Sans' },
    body: null, cta: null,
    ft:  { xf:0.08, yf:0.94, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'grain',
    deco: { mood:'editorial',
      layers:['corner-l-brackets','separator-h-thin','micro-label-above','grain-texture'],
      has_gradient:false, has_glow:false, has_pattern:true, shape_count:4 },
  },

  'IG-POST-FRAME': {
    name: 'Frame Interno',
    desc: 'Conteúdo dentro de moldura — profundidade e sofisticação',
    formats: ['post'], networks: ['ig'],
    content_types: ['promotional','educational','motivational'],
    hl:  { xf:0.13, yf:0.46, sf:0.085, lhm:1.18, anchor:'start' },
    sub: { xf:0.13, ybl:0.060, sf:0.028, w:'400' },
    body: null,
    cta: { xf:0.13, yf:0.76 },
    ft:  { xf:0.13, yf:0.90, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'noise',
    deco: { mood:'frame-depth',
      layers:['inner-frame-rect','corner-accents','glow-behind','noise-subtle'],
      has_gradient:true, has_glow:true, has_pattern:false, shape_count:4 },
  },

  // ─── POST ÚNICO — TEMPLATES POR SUB-FORMATO ──────────────────────────────

  'IG-POST-CENTERED': {
    name: 'Big Statement — Central',
    desc: 'Frase única dominante centralizada — espaço em branco como design intencional',
    formats: ['post','anuncio'], networks: ['ig','li'],
    content_types: ['motivational','educational','storytelling'],
    hl:  { xf:0.50, yf:0.48, sf:0.128, lhm:1.12, anchor:'middle', transform:'uppercase' },
    sub: null,
    body: null, cta: null,
    ft:  { xf:0.07, yf:0.95, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'noise',
    deco: { mood:'big-statement-centered',
      layers:['radial-glow-center','noise-texture','accent-rule-top','accent-rule-bottom-sym'],
      has_gradient:true, has_glow:true, has_pattern:false, shape_count:3 },
  },

  'IG-POST-QUESTION': {
    name: 'Question Hook — Gancho',
    desc: 'Pergunta provocadora que para o scroll — curiosidade imediata em 0,3s',
    formats: ['post'], networks: ['ig','li'],
    content_types: ['educational','motivational'],
    hl:  { xf:0.12, yf:0.46, sf:0.105, lhm:1.20, anchor:'start' },
    sub: { xf:0.12, ybl:0.075, sf:0.028, w:'300' },
    body: null, cta: null,
    ft:  { xf:0.12, yf:0.95, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'subtle',
    deco: { mood:'question-hook',
      layers:['accent-bar-left-full','radial-glow-top-left','noise-texture'],
      has_gradient:true, has_glow:true, has_pattern:false, shape_count:3 },
  },

  'IG-POST-QUOTE': {
    name: 'Quote de Autoridade',
    desc: 'Citação elegante com aspas grandes — credibilidade e autoridade máximas',
    formats: ['post'], networks: ['ig','li'],
    content_types: ['motivational','storytelling'],
    hl:  { xf:0.09, yf:0.54, sf:0.072, lhm:1.30, anchor:'start', font:'Playfair Display' },
    sub: { xf:0.09, ybl:0.090, sf:0.024, w:'300', font:'DM Sans' },
    body: null, cta: null,
    ft:  { xf:0.09, yf:0.95, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'grain',
    deco: { mood:'quote-authority',
      layers:['large-quote-marks','separator-h-thin','grain-texture','accent-rule-left'],
      has_gradient:false, has_glow:false, has_pattern:true, shape_count:3 },
  },

  'IG-POST-SPLIT': {
    name: 'Antes / Depois — Contraste',
    desc: 'Divisão visual clara entre antes e depois — transformação que converte',
    formats: ['post'], networks: ['ig','li'],
    content_types: ['promotional','educational'],
    hl:  { xf:0.07, yf:0.28, sf:0.078, lhm:1.15, anchor:'start' },
    sub: { xf:0.07, ybl:0.065, sf:0.026, w:'300' },
    body:{ xf:0.07, ysf:0.57, sf:0.027, lhm:1.85, prefix:'→' },
    cta: null,
    ft:  { xf:0.07, yf:0.95, sf:0.017 },
    db:  null,
    bg_pref: 'dark', texture: 'subtle',
    deco: { mood:'before-after-split',
      layers:['horizontal-split-divider','accent-tone-bottom-half','noise-texture'],
      has_gradient:true, has_glow:false, has_pattern:false, shape_count:3 },
  },

  // ─── CARROSSEL 1080×1080 ──────────────────────────────────────────────────

  'CARR-CAPA': {
    name: 'Carrossel — Capa',
    desc: 'Primeiro slide — hook visual + promessa de valor irresistível',
    formats: ['carrossel'], networks: ['ig','li'],
    content_types: ['educational','motivational','data-driven','promotional'],
    hl:  { xf:0.07, yf:0.46, sf:0.112, lhm:1.12, anchor:'start' },
    sub: { xf:0.07, ybl:0.060, sf:0.030, w:'400' },
    body: null,
    cta: { xf:0.07, yf:0.82, label:'ARRASTE →' },
    ft:  { xf:0.07, yf:0.95, sf:0.016 },
    db:  null, si: { xf:0.93, yf:0.07, anchor:'end' },
    bg_pref: 'dark', texture: 'noise',
    deco: { mood:'carousel-cover',
      layers:['gradient-dramatic','radial-glow-center','accent-diagonal','badge-count'],
      has_gradient:true, has_glow:true, has_pattern:true, shape_count:4 },
  },

  'CARR-SLIDE': {
    name: 'Carrossel — Slide Interno',
    desc: 'Slide de desenvolvimento — 1 ideia forte por slide',
    formats: ['carrossel'], networks: ['ig','li'],
    content_types: ['educational','motivational','data-driven'],
    hl:  { xf:0.07, yf:0.52, sf:0.086, lhm:1.15, anchor:'start' },
    sub: { xf:0.07, ybl:0.055, sf:0.028, w:'400' },
    body:{ xf:0.07, ysf:0.74, sf:0.024, lhm:1.70, prefix:'none' },
    cta: null,
    ft:  { xf:0.07, yf:0.95, sf:0.015 },
    db:  null, si: { xf:0.93, yf:0.07, anchor:'end' },
    // Número de slide grande e translúcido no canto superior esquerdo
    slide_num: { xf:0.07, yf:0.28, sf:0.18, alpha:0.15 },
    bg_pref: 'dark', texture: 'consistent',
    deco: { mood:'carousel-slide',
      layers:['accent-rule-left','separator-h-after-num','subtle-bg-lighter'],
      has_gradient:true, has_glow:false, has_pattern:false, shape_count:2 },
  },

  'CARR-FINAL': {
    name: 'Carrossel — Slide Final',
    desc: 'Último slide — resumo + CTA forte + handle em destaque',
    formats: ['carrossel'], networks: ['ig','li'],
    content_types: ['educational','motivational','data-driven','promotional'],
    hl:  { xf:0.07, yf:0.36, sf:0.094, lhm:1.15, anchor:'start' },
    sub: { xf:0.07, ybl:0.055, sf:0.030, w:'400' },
    body: null,
    cta: { xf:0.07, yf:0.66 },
    ft:  { xf:0.07, yf:0.88, sf:0.024 },   // handle maior no slide final
    db:  null, si: { xf:0.93, yf:0.07, anchor:'end' },
    bg_pref: 'dark', texture: 'noise',
    deco: { mood:'carousel-final',
      layers:['radial-glow-cta','separator-h-above-cta','corner-frame','accent-burst'],
      has_gradient:true, has_glow:true, has_pattern:false, shape_count:3 },
  },

  // ─── STORY / REELS 1080×1920 ─────────────────────────────────────────────

  'ST-HOOK': {
    name: 'Story — Hook de Curiosidade',
    desc: 'Pergunta ou afirmação que para o dedo — impacto imediato nos 3s',
    formats: ['story','reels'], networks: ['ig','tt'],
    content_types: ['motivational','educational','promotional'],
    hl:  { xf:0.07, yf:0.42, sf:0.086, lhm:1.15, anchor:'start' },
    sub: { xf:0.07, ybl:0.055, sf:0.034, w:'400' },
    body: null,
    cta: { xf:0.07, yf:0.80 },
    ft:  { xf:0.07, yf:0.96, sf:0.018 },
    db:  null,
    bg_pref: 'dark', texture: 'gradient-v',
    deco: { mood:'story-hook',
      layers:['gradient-top-bottom','accent-shape-abstract','blur-orb-bg'],
      has_gradient:true, has_glow:true, has_pattern:false, shape_count:3 },
  },

  'TT-HOOK': {
    name: 'TikTok — Hook Visual',
    desc: 'Caption bold orgânico + background expressivo — feel nativo do TikTok',
    formats: ['story','reels'], networks: ['tt'],
    content_types: ['motivational','educational','promotional'],
    hl:  { xf:0.07, yf:0.30, sf:0.068, lhm:1.18, anchor:'start' },
    sub: { xf:0.07, ybl:0.055, sf:0.038, w:'300' },
    body: null, cta: null,
    ft:  { xf:0.07, yf:0.94, sf:0.022 },
    db:  null,
    bg_pref: 'dark', texture: 'noise-heavy',
    deco: { mood:'tiktok-native',
      layers:['dark-gradient-bottom','accent-vertical-bar','noise-heavy-texture'],
      has_gradient:true, has_glow:false, has_pattern:false, shape_count:2 },
  },

  // ─── THUMBNAIL ────────────────────────────────────────────────────────────

  'YT-IMPACTO': {
    name: 'YouTube — Impacto',
    desc: 'Thumbnail de alto CTR — texto bold + fundo vibrante (testado MrBeast/Pewdiepie style)',
    formats: ['thumb'], networks: ['yt'],
    content_types: ['educational','motivational','data-driven','promotional'],
    hl:  { xf:0.05, yf:0.60, sf:0.128, lhm:1.10, anchor:'start', font:'Bebas Neue', transform:'uppercase' },
    sub: { xf:0.05, ybl:0.055, sf:0.052, w:'700', font:'DM Sans' },
    body: null, cta: null, ft: null,  // thumbs não têm footer
    db:  null,
    bg_pref: 'vibrant', texture: 'none',
    deco: { mood:'youtube-impact',
      layers:['vibrant-bg-solid','text-drop-shadow-heavy','accent-rectangle-corner','diagonal-stripe'],
      has_gradient:false, has_glow:false, has_pattern:false, shape_count:3 },
  },

  'YT-NÚMERO': {
    name: 'YouTube — Número + Promessa',
    desc: 'Número grande + promessa clara — CTR alto para listas e tutoriais',
    formats: ['thumb'], networks: ['yt'],
    content_types: ['educational','data-driven'],
    // Número lado esquerdo, headline lado direito
    hl:  { xf:0.42, yf:0.55, sf:0.095, lhm:1.15, anchor:'start', font:'Bebas Neue' },
    sub: { xf:0.42, ybl:0.080, sf:0.048, w:'400' },
    body: null, cta: null, ft: null,
    db:  { xf:0.08, yf:0.62, sf:0.280, anchor:'start', font:'Bebas Neue' },
    bg_pref: 'dark', texture: 'none',
    deco: { mood:'youtube-number',
      layers:['vertical-divider-center','radial-glow-left','gradient-bg','accent-bar-left'],
      has_gradient:true, has_glow:true, has_pattern:false, shape_count:3 },
  },

  'IG-THUMB': {
    name: 'Instagram Reels Thumbnail',
    desc: 'Thumbnail 4:5 para Reels — hook visual na grade do perfil',
    formats: ['thumb'], networks: ['ig','tt'],
    content_types: ['educational','motivational','promotional'],
    hl:  { xf:0.07, yf:0.35, sf:0.090, lhm:1.15, anchor:'start' },
    sub: { xf:0.07, ybl:0.060, sf:0.036, w:'400' },
    body: null, cta: null,
    ft:  { xf:0.07, yf:0.94, sf:0.022 },
    db:  null,
    bg_pref: 'dark', texture: 'noise',
    deco: { mood:'reels-cover',
      layers:['gradient-top-overlay','accent-shape-dynamic','glow-center'],
      has_gradient:true, has_glow:true, has_pattern:false, shape_count:2 },
  },

  // ─── BANNER LINKEDIN 1584×396 ─────────────────────────────────────────────

  'BN-LI-POSICIONAMENTO': {
    name: 'Banner LinkedIn — Posicionamento',
    desc: 'Headline + especialidade — identidade profissional no perfil',
    formats: ['banner'], networks: ['li'],
    content_types: ['educational','promotional'],
    // Safe zone X: 30-90% (foto de perfil ocupa esquerda)
    hl:  { xf:0.33, yf:0.48, sf:0.092, lhm:1.15, anchor:'start' },
    sub: { xf:0.33, ybl:0.090, sf:0.040, w:'400' },
    body: null, cta: null,
    ft:  { xf:0.33, yf:0.82, sf:0.034 },
    db:  null,
    bg_pref: 'dark', texture: 'subtle',
    deco: { mood:'linkedin-professional',
      layers:['gradient-left-fade','vertical-accent-line','decorative-shape-left'],
      has_gradient:true, has_glow:false, has_pattern:false, shape_count:3 },
  },

  'BN-LI-METRICA': {
    name: 'Banner LinkedIn — Métricas',
    desc: '3 números em destaque horizontal — prova social poderosa',
    formats: ['banner'], networks: ['li'],
    content_types: ['data-driven','promotional'],
    hl:  { xf:0.50, yf:0.30, sf:0.072, lhm:1.15, anchor:'middle' },
    // métricas: 3 grupos x/y calculados no resolveLayout
    metrics: { count:3, yf:0.68, sf:0.135, lsf:0.038 },
    body: null, cta: null, ft: null, db: null,
    bg_pref: 'dark', texture: 'grid',
    deco: { mood:'metrics-banner',
      layers:['gradient-dark','vertical-separators-metrics','glow-center-subtle','grid-pattern-light'],
      has_gradient:true, has_glow:true, has_pattern:true, shape_count:3 },
  },
};

// ── Helpers de layout determinístico ─────────────────────────────────────────

/** Quebra texto em linhas que cabem em maxPx com o fontSize dado. */
function splitLines(text, maxPx, fontSize, charRatio) {
  const ratio = charRatio || 0.58;
  const maxC  = Math.max(1, Math.floor(maxPx / (fontSize * ratio)));
  const words = String(text || '').split(' ');
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (t.length <= maxC) { cur = t; }
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

// Maps sub-format IDs (from user selection) to the best matching layout template.
const SUB_FORMAT_TEMPLATE_MAP = {
  BIG_STATEMENT:         'IG-POST-CENTERED',
  QUESTION_HOOK:         'IG-POST-QUESTION',
  CONTROVERSIAL_OPINION: 'IG-POST-IMPACTO',
  QUICK_TIP:             'IG-POST-LISTA',
  MINI_LIST:             'IG-POST-LISTA',
  QUOTE_AUTHORITY:       'IG-POST-QUOTE',
  BEFORE_AFTER:          'IG-POST-SPLIT',
  CTA_POST:              'IG-POST-FRAME',
  STAT_POST:             'IG-POST-DADO',
  BRAND_STATEMENT:       'IG-POST-EDITORIAL',
};

/** Seleciona o template mais adequado para o contexto. */
function selectTemplate(format, network, brief, slideRole, subFormat) {
  // Sub-format override: user explicitly chose a visual template — always honor it.
  if (subFormat && (format === 'post' || format === 'anuncio')) {
    const mapped = SUB_FORMAT_TEMPLATE_MAP[subFormat];
    if (mapped && LAYOUT_TEMPLATES[mapped]) return mapped;
  }
  const ct  = brief.content_type || 'educational';
  const em  = brief.emphasis     || 'statement';
  const hasData = !!brief.data_highlight;
  const net = (network || '').toLowerCase().replace('instagram','ig').replace('linkedin','li')
    .replace('youtube','yt').replace('tiktok','tt');

  if (format === 'carrossel') {
    const r = (slideRole || '').toUpperCase();
    if (r.includes('CAPA') || r.match(/\b1\s*DE\b/)) return 'CARR-CAPA';
    if (r.includes('FECHAMENTO') || r.includes('FINAL')) return 'CARR-FINAL';
    return 'CARR-SLIDE';
  }
  if (format === 'story' || format === 'reels') {
    return (net === 'tt') ? 'TT-HOOK' : 'ST-HOOK';
  }
  if (format === 'thumb') {
    if (net === 'yt') return (hasData && em === 'number') ? 'YT-NÚMERO' : 'YT-IMPACTO';
    return 'IG-THUMB';
  }
  if (format === 'banner') {
    return (hasData && (brief.body_points||[]).length >= 2) ? 'BN-LI-METRICA' : 'BN-LI-POSICIONAMENTO';
  }
  // Post único
  if (hasData && em === 'number') return 'IG-POST-DADO';
  if (ct === 'educational' && (brief.body_points||[]).length >= 3) return 'IG-POST-LISTA';
  if ((net === 'li') && (ct === 'storytelling' || ct === 'educational')) return 'IG-POST-EDITORIAL';
  if (ct === 'motivational' || em === 'statement' || em === 'quote') return 'IG-POST-IMPACTO';
  return 'IG-POST-IMPACTO';
}

/** Converte um template + dimensões em blueprint de coordenadas absolutas. */
function resolveLayout(templateId, dim, brief, brand) {
  const tpl = LAYOUT_TEMPLATES[templateId];
  if (!tpl) return null;
  const W = dim.w, H = dim.h;
  const BASE = Math.min(W, H);   // escala tipográfica relativa ao menor lado
  const marg = Math.round(BASE * 0.07);

  function px(frac, base) { return Math.round(frac * (base || W)); }
  function sz(sf)  { return Math.round(BASE * (sf || 0.05)); }
  function fontStack(f) { return (f || 'DM Sans').split('|')[0].trim(); }

  const out = { _templateId: templateId, _templateName: tpl.name, layers: [] };

  // Background base
  out.bg = {
    type: 'linear-gradient',
    color: brand.p2,
    grad_from: brand.p2,
    grad_to: brand.p2,
    grad_angle: 135,
    overlay_type: tpl.texture === 'noise' ? 'noise' : 'none',
    overlay_color: '#ffffff',
    overlay_opacity: 0.03,
  };

  // HEADLINE
  if (tpl.hl) {
    const hlSize = sz(tpl.hl.sf);
    const hlX    = px(tpl.hl.xf, W);
    const hlY    = px(tpl.hl.yf, H);
    const hlMaxW = (tpl.hl.anchor === 'middle') ? (W - marg * 2) : (W - hlX - marg);
    const hlLH   = Math.round(hlSize * (tpl.hl.lhm || 1.15));
    const hlLines = splitLines(brief.headline, hlMaxW, hlSize, 0.58);
    out.headline = {
      text: brief.headline, lines: hlLines,
      font: fontStack(tpl.hl.font || 'Bebas Neue'),
      size: hlSize, weight: tpl.hl.weight || '400',
      color: brand.p3, x: hlX, y: hlY, max_w: hlMaxW,
      line_h: hlLH, anchor: tpl.hl.anchor || 'start',
      letter_spacing: 0,
      transform: tpl.hl.transform || 'none',
    };
  }

  // SUBHEADLINE
  if (tpl.sub && brief.subheadline) {
    const subSize = sz(tpl.sub.sf);
    const subX    = px(tpl.sub.xf || tpl.hl?.xf || 0.07, W);
    const hlRef   = out.headline;
    const hlBottom= hlRef ? hlRef.y + hlRef.lines.length * hlRef.line_h : px(0.55, H);
    const subY    = hlBottom + Math.round(H * (tpl.sub.ybl || 0.05));
    const subMaxW = W - subX - marg;
    const subLines = splitLines(brief.subheadline, subMaxW, subSize, 0.54);
    out.subheadline = {
      text: brief.subheadline, lines: subLines,
      font: fontStack(tpl.sub.font || 'DM Sans'),
      size: subSize, weight: tpl.sub.w || '400',
      color: brand.p4, x: subX, y: subY, max_w: subMaxW,
    };
  }

  // BODY POINTS
  if (tpl.body && (brief.body_points||[]).length > 0) {
    const bSize = sz(tpl.body.sf);
    out.body = {
      font: fontStack('DM Sans'),
      size: bSize, weight: '400', color: brand.p4,
      line_h: Math.round(bSize * (tpl.body.lhm || 1.80)),
      x: px(tpl.body.xf, W),
      y_start: px(tpl.body.ysf, H),
      max_w: W - px(tpl.body.xf, W) - marg,
      prefix: tpl.body.prefix || '→',
    };
  }

  // CTA BUTTON
  const ctaText = brief.cta || (tpl.cta?.label) || 'Saiba mais';
  if (tpl.cta) {
    const ctaSize = sz(0.022);
    out.cta_block = {
      text: ctaText, font: 'DM Sans',
      size: ctaSize, weight: '700',
      color: brand.p2, bg_color: brand.p1,
      x: px(tpl.cta.xf, W), y: px(tpl.cta.yf, H),
      pad_x: 32, pad_y: 14, rx: 8, border_color: 'none',
    };
  }

  // FOOTER / HANDLE
  if (tpl.ft) {
    out.footer = {
      handle: brand.handle, font: 'DM Sans',
      size: sz(tpl.ft.sf || 0.017), color: brand.p4,
      x: px(tpl.ft.xf, W),
      y: Math.min(px(tpl.ft.yf, H), H - 12),
    };
  }

  // DATA BLOCK (número hero)
  if (tpl.db && brief.data_highlight) {
    const dbSize = sz(tpl.db.sf || 0.22);
    const dbX    = px(tpl.db.xf, W);
    const dbY    = px(tpl.db.yf, H);
    out.data_block = {
      number: brief.data_highlight,
      number_font: fontStack(tpl.db.font || 'Bebas Neue'),
      number_size: dbSize, number_color: brand.p1,
      label: (brief.body_points||[])[0] || '',
      label_font: 'DM Sans', label_size: Math.round(dbSize * 0.18), label_color: brand.p4,
      x: dbX, y: dbY, bg_rect: null,
    };
  }

  // SLIDE INDICATOR
  if (tpl.si) {
    out.slide_indicator = {
      text: '', // preenchido pela rota com slideIndex/totalSlides
      x: px(tpl.si.xf, W), y: px(tpl.si.yf, H),
      color: brand.p4, size: sz(0.018), anchor: tpl.si.anchor || 'end',
    };
  }

  // Accent + separator placeholder — Stage 3 completa com cor
  out.accent    = { type: 'none' };
  out.separator = null;
  // Decoração: repassa as instruções do template para o Stage 3
  out._deco = tpl.deco;

  return out;
}

// ── Estágio 1: Brief Analyst ──────────────────────────────────────────────────
// Recebe o input bruto e extrai a hierarquia de conteúdo em JSON estruturado.
// Garante que o texto seja real, específico, no tom da marca.
async function daStage1Brief({ prompt, format, network, brand, slideRole, blueprint, slideIndex, subFormat }) {
  const fmtLabel = { post:'Post', carrossel:'Carrossel', story:'Story', reels:'Reels',
                     thumb:'Thumbnail', banner:'Banner', anuncio:'Anúncio' }[format] || format;
  const subFmtDescriptions = {
    BIG_STATEMENT:'Single dominant phrase, centered, lots of white space',
    QUESTION_HOOK:'Large question + small complement, vertical accent bar',
    CONTROVERSIAL_OPINION:'Strong opinion statement highlighted',
    QUICK_TIP:'Pill label + short title + divider + body text',
    MINI_LIST:'Hook title + 3 numbered items',
    QUOTE_AUTHORITY:'Quote marks + elegant text + author name',
    BEFORE_AFTER:'Vertical split: left=before (muted), right=after (accent)',
    CTA_POST:'Strong headline + body + prominent CTA button',
    STAT_POST:'Large number as hero + accent divider + explanation',
    BRAND_STATEMENT:'Clean sophisticated positioning, accent lines, brand logo area',
    LIST_CAROUSEL:'Hook slide → 1 item per slide with numbered circles → CTA slide',
    EDUCATIONAL_CAROUSEL:'Hook block → progressive content blocks → conclusion',
    MISTAKE_CAROUSEL:'Hook → mistakes (red markers) per slide → solution slide',
    STEP_BY_STEP:'Hook → numbered steps on timeline → result slide',
    STORY_CAROUSEL:'Emotional hook → development → climax → conclusion',
    CONTRAST_CAROUSEL:'Two-column comparison: left=old/bad, right=new/good',
    CHECKLIST_CAROUSEL:'Hook → checklist items → CTA',
    MYTH_BUSTING:'Hook → alternating MYTH/TRUTH pairs',
    TIPS_CAROUSEL:'Hook → bullet tips per slide → CTA',
    TRANSFORMATION:'Before block (muted) → arrow/divider → After block (bright)',
  };
  const system =
`Você é o CREATIVE BRIEF MASTER — Estágio 1 do Design Agent de elite mundial.
MISSÃO: Transformar qualquer input em hierarquia de conteúdo IRRESISTÍVEL que para o scroll e converte.

CONTEXTO DA MARCA:
Profissão: ${brand.profissao} | Nicho: ${brand.nicho} | Tom: ${brand.tom} | Público: ${brand.publico}
Formato: ${fmtLabel} → ${DA_NET_LABELS[network] || network}${subFormat ? `\nSub-formato obrigatório: ${subFormat} — ${subFmtDescriptions[subFormat]||subFormat}\nIMPORTANTE: A composition_hint deve refletir este sub-formato.` : ''}${slideRole ? `\nFunção do slide: ${slideRole}` : ''}

━━━ PSICOLOGIA DO SCROLL-STOP + COPYWRITING DE CONVERSÃO ━━━

HEADLINE — O GANCHO QUE PRENDE EM 0,3 SEGUNDOS:
• Máx 7 palavras — cada palavra carrega peso; elimine adjetivos fracos e genéricos
• Padrões comprovados por neurociência de conversão:
  NÚMERO ESPECÍFICO: "7 gatilhos que triplicam fechamentos"
  CONTRASTE BRUTAL: "Trabalhadores duram. Estrategistas prosperam."
  LACUNA DE CURIOSIDADE: "O gap que separa top 1% do resto"
  PARADOXO: "Por que mais esforço reduz resultado"
  TRANSFORMAÇÃO CONCRETA: "De R$10k para R$100k: o que mudou"
  PERGUNTA INCÔMODA: "Por que você ainda cobra por hora?"
  AFIRMAÇÃO POLÊMICA: "Networking é perda de tempo disfarçada"
• Gatilhos psicológicos obrigatórios: FOMO / Identidade / Curiosidade lacunar / Urgência
• Tom obrigatório: ${brand.tom}
• NUNCA use: importante, essencial, incrível, perfeito, ótimo, excelente

SUBHEADLINE — RESOLVE A TENSÃO E ESPECIFICA:
• Máx 14 palavras — QUÊ exatamente + PARA QUEM + RESULTADO mensurável
• Fórmula: [Ação específica] + [Condição ou contexto] + [Resultado tangível]
• Exemplos fortes: "Para donos de negócio que já tentaram e sentiram que algo estava faltando"
• Complementa sem repetir — adiciona especificidade e credibilidade

BODY POINTS — PROVA, PROFUNDIDADE, CREDIBILIDADE:
• Máx 3 itens, máx 8 palavras cada
• Estrutura: verbo de impacto + benefício concreto + qualificador/dado
• Verbos poderosos: Elimina / Dobra / Garante / Acelera / Reverte / Desbloqueia / Converte
• Pelo menos 1 item com dado numérico específico quando possível
• Cada ponto deve ser autônomo e convincente por si só

CTA — A ORDEM IRRECUSÁVEL:
• Máx 4 palavras — verbo imperativo + benefício implícito
• Alta conversão: "Descubra o método" / "Acesse agora" / "Garanta sua vaga" / "Ative hoje"

DATA HIGHLIGHT — O NÚMERO QUE CONVENCE:
• O dado mais específico e impactante possível (ex: "3,4x", "R$127k", "93%", "19 dias")
• Números quebrados convencem mais: 87% > 90%, R$4.700 > R$5.000
• Se não fornecido: crie dado contextualmente crível e específico para o nicho
• null APENAS se completamente incompatível com o conteúdo

━━━ RETORNE SOMENTE JSON VÁLIDO ━━━
{
  "headline": "gancho irresistível máx 7 palavras",
  "subheadline": "complemento específico e quantificado ou null",
  "body_points": ["verbo+benefício+dado 1", "verbo+benefício+dado 2", "verbo+benefício+dado 3"],
  "cta": "ação direta máx 4 palavras",
  "data_highlight": "dado impactante e específico ou null",
  "visual_mood": "dark-power | clean-premium | bold-energy | soft-trust | tech-sharp",
  "content_type": "educational | motivational | promotional | storytelling | data-driven",
  "emphasis": "number | quote | list | statement | question",
  "font_mood": "display-bold | editorial | monospace | serif-elegant | sans-clean",
  "composition_hint": "text-dominant | data-hero | split-layout | quote-focus | list-view"
}`;

  // Fast path: structured blueprint from refiner — 0 tokens needed
  if (blueprint && blueprint.headline && format !== 'carrossel') {
    const styleMap = { minimal:'clean-premium', editorial:'editorial-warm', luxury:'clean-premium',
      modern:'tech-sharp', bold:'bold-energy', typographic:'dark-power', warm:'soft-trust' };
    const fontMap = { 'bold-uppercase':'display-bold', 'mixed-weight':'display-bold',
      'serif-italic':'serif-elegant', 'display-black':'display-bold', editorial:'editorial' };
    // Derive emphasis and content_type from the user-selected sub-format
    const emphasisMap = {
      STAT_POST:'number', MINI_LIST:'list', QUICK_TIP:'list', QUOTE_AUTHORITY:'quote',
      QUESTION_HOOK:'question', BIG_STATEMENT:'statement', CONTROVERSIAL_OPINION:'statement',
      BEFORE_AFTER:'statement', CTA_POST:'statement', BRAND_STATEMENT:'statement',
    };
    const ctypeMap = {
      STAT_POST:'data-driven', QUOTE_AUTHORITY:'storytelling', BEFORE_AFTER:'promotional',
      CTA_POST:'promotional', BRAND_STATEMENT:'educational', MINI_LIST:'educational',
      QUICK_TIP:'educational',
    };
    const compositionMap = {
      BIG_STATEMENT:'text-dominant', QUESTION_HOOK:'text-dominant', STAT_POST:'data-hero',
      MINI_LIST:'list-view', QUICK_TIP:'list-view', QUOTE_AUTHORITY:'quote-focus',
      BEFORE_AFTER:'split-layout', CTA_POST:'text-dominant', BRAND_STATEMENT:'editorial',
    };
    return {
      data: {
        headline: blueprint.headline,
        subheadline: blueprint.subheadline || null,
        body_points: Array.isArray(blueprint.body_points) ? blueprint.body_points : [],
        cta: blueprint.cta || 'Saiba mais',
        data_highlight: blueprint.data_highlight || null,
        visual_mood: styleMap[blueprint.visual?.style] || 'dark-power',
        content_type: blueprint.type === 'carousel' ? 'educational'
          : (ctypeMap[subFormat] || 'motivational'),
        emphasis: emphasisMap[subFormat] || 'statement',
        font_mood: fontMap[blueprint.typography?.headline_style] || 'display-bold',
        composition_hint: compositionMap[subFormat] || 'text-dominant',
        _blueprint: blueprint,
      },
      tok: { in: 0, out: 0 },
    };
  }

  const r = await callClaude({
    system,
    userMsg: `INPUT: "${prompt}"\n\nAnalise e extraia a hierarquia de conteúdo com copywriting de nível mundial:`,
    maxTokens: 900,
  });
  try {
    const m = r.text.match(/\{[\s\S]*?\}/);
    return { data: JSON.parse(m[0]), tok: { in: r.inputTokens, out: r.outputTokens } };
  } catch {
    return {
      data: {
        headline: prompt.slice(0, 50), subheadline: null, body_points: [],
        cta: 'Saiba mais', data_highlight: null,
        visual_mood: 'dark-power', content_type: 'educational', emphasis: 'statement',
      },
      tok: { in: r.inputTokens || 0, out: r.outputTokens || 0 },
    };
  }
}

// ── Estágio 2: Art Director ───────────────────────────────────────────────────
// Recebe o brief estruturado e define um blueprint de design com coordenadas,
// tipografia, cores e layout exatos — eliminando ambiguidade para o SVG Executor.
// ── Estágio 2: Template Selector + Palette Finalizer ─────────────────────────
// Nova arquitetura: layout resolvido deterministicamente (0 tokens de IA para posições).
// Claude só decide: cores de destaque, gradiente bg, atmosphere mood. ~400 tokens max.
async function daStage2ArtDir({ brief, brand, dim, format, slideIndex, totalSlides, slideRole, network, subFormat }) {
  const voice = brand.voiceId ? (BRAND_VOICES[brand.voiceId] || '') : '';
  const dna   = voice || (brand.modelN ? (STYLE_DNA[brand.modelN] || '') : '');

  // 1) Seleciona template por formato + conteúdo (determinístico) — subFormat tem prioridade
  const tplId = selectTemplate(format, network || 'ig', brief, slideRole, subFormat);

  // 2) Resolve layout completo em px absolutos (sem IA)
  const blueprint = resolveLayout(tplId, dim, brief, brand);

  // 3) Preenche slide indicator se carrossel
  if (blueprint.slide_indicator && slideIndex) {
    blueprint.slide_indicator.text = `${slideIndex}${totalSlides ? '/' + totalSlides : ''}`;
  }

  // 4) Apply colors: use blueprint colors if available (0 tokens), else Claude palette call
  const brief_bp = brief._blueprint;
  if (brief_bp?.colors) {
    const c = brief_bp.colors;
    blueprint.bg.color      = c.background || brand.p2;
    blueprint.bg.grad_from  = c.background || brand.p2;
    blueprint.bg.grad_to    = c.background || brand.p2;
    blueprint.glow_color    = c.accent     || brand.p1;
    if (blueprint.headline)    blueprint.headline.color    = c.text   || brand.p3;
    if (blueprint.subheadline) blueprint.subheadline.color = c.text   || brand.p4;
    if (blueprint.footer)      blueprint.footer.color      = c.text   || brand.p4;
    if (blueprint.cta_block)   blueprint.cta_block.bg_color = c.accent || brand.p1;
    blueprint._accent_color = c.accent || brand.p1;
    const toneAtmo = { bold:'strong typographic power', editorial:'editorial precision', luxury:'premium refinement',
      minimal:'clean breathing space', authoritative:'confident dark depth', warm:'organic warmth' };
    blueprint._atmosphere = toneAtmo[brief_bp.tone] || 'strong visual impact';
    return { data: blueprint, tok: { in: 0, out: 0 } };
  }

  // Lightweight Claude call: palette only (~300 tokens) — fallback when no blueprint colors
  const palettePrompt = `Você é um colorista de design. Baseado no brief e DNA da marca, retorne JSON compacto de cores:
{"bg_color":"#hex","bg_grad_from":"#hex","bg_grad_to":"#hex","bg_grad_angle":135,"hl_color":"#hex","sub_color":"#hex","ft_color":"#hex","accent_color":"#hex","glow_color":"#hex","atmosphere":"..."}

Marca: ${brand.profissao} | Nicho: ${brand.nicho} | Tom: ${brand.tom}
Paleta base: p1=${brand.p1} p2=${brand.p2} p3=${brand.p3} p4=${brand.p4}
Template: ${blueprint._templateName} | Visual mood: ${brief.visual_mood || 'dark-power'}
Headline: "${brief.headline}"`;

  let tok = { in: 0, out: 0 };
  try {
    const r = await callClaude({ system: palettePrompt, userMsg: 'Retorne o JSON de cores:', maxTokens: 300 });
    tok = { in: r.inputTokens || 0, out: r.outputTokens || 0 };
    const m = r.text.match(/\{[\s\S]*?\}/);
    if (m) {
      const pal = JSON.parse(m[0]);
      if (pal.bg_color)      { blueprint.bg.color = pal.bg_color; blueprint.bg.grad_from = pal.bg_grad_from||pal.bg_color; blueprint.bg.grad_to = pal.bg_grad_to||pal.bg_color; blueprint.bg.grad_angle = pal.bg_grad_angle||135; }
      if (pal.hl_color && blueprint.headline)    blueprint.headline.color    = pal.hl_color;
      if (pal.sub_color && blueprint.subheadline) blueprint.subheadline.color = pal.sub_color;
      if (pal.ft_color && blueprint.footer)      blueprint.footer.color      = pal.ft_color;
      if (pal.glow_color)    blueprint.glow_color    = pal.glow_color;
      if (pal.accent_color)  blueprint._accent_color = pal.accent_color;
      if (pal.atmosphere)    blueprint._atmosphere   = pal.atmosphere;
      if (pal.accent_color && blueprint.cta_block) blueprint.cta_block.bg_color = pal.accent_color;
    }
  } catch { /* silent fallback */ }

  return { data: blueprint, tok };
}

// ── Helper: pré-renderiza todos os elementos de TEXTO em SVG determinístico ──
// O resultado é injetado verbatim no Stage 3 — elimina posicionamento errado pela IA.
function buildTextElements({ brief, blueprint, dim, margin }) {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fontStack(f) { return esc((f || 'DM Sans').split('|')[0].trim()) + ',sans-serif'; }

  const hl  = blueprint.headline  || {};
  const sub = blueprint.subheadline;
  const ft  = blueprint.footer    || {};
  const cta = blueprint.cta_block;
  const bdy = blueprint.body;
  const db  = blueprint.data_block;
  const si  = blueprint.slide_indicator;

  const hlLines = (Array.isArray(hl.lines) && hl.lines.length > 0)
    ? hl.lines : [hl.text || brief.headline];
  const subLines = sub ? ((Array.isArray(sub.lines) && sub.lines.length > 0)
    ? sub.lines : (sub.text ? [sub.text] : [])) : [];

  const hlX    = hl.x    != null ? hl.x    : margin;
  const hlY    = hl.y    != null ? hl.y    : Math.round(dim.h * 0.40);
  const hlSize = hl.size || 96;
  const hlLH   = hl.line_h || Math.round(hlSize * 1.18);
  const hlLS   = hl.letter_spacing ? ` letter-spacing="${hl.letter_spacing}"` : '';

  let out = '<!-- ╔══ TEXTO PRÉ-CALCULADO — NÃO ALTERE NENHUMA DESTAS LINHAS ══╗ -->\n';

  // HEADLINE
  out += `<text x="${hlX}" y="${hlY}" font-family="${fontStack(hl.font)}" font-size="${hlSize}" font-weight="${hl.weight || 400}" fill="${esc(hl.color || '#FFFFFF')}" text-anchor="${hl.anchor || 'start'}"${hlLS} text-rendering="optimizeLegibility">`;
  hlLines.forEach((line, i) => {
    out += `<tspan x="${hlX}" dy="${i === 0 ? 0 : hlLH}">${esc(line)}</tspan>`;
  });
  out += `</text>\n`;

  // SUBHEADLINE
  if (sub && subLines.length > 0) {
    const subX    = sub.x    != null ? sub.x    : margin;
    const subY    = sub.y    != null ? sub.y    : hlY + hlLines.length * hlLH + Math.round(hlSize * 0.35);
    const subSize = sub.size || 26;
    const subLH   = Math.round(subSize * 1.45);
    out += `<text x="${subX}" y="${subY}" font-family="${fontStack(sub.font)}" font-size="${subSize}" font-weight="${sub.weight || 400}" fill="${esc(sub.color || '#CCCCCC')}" text-rendering="optimizeLegibility">`;
    subLines.forEach((line, i) => {
      out += `<tspan x="${subX}" dy="${i === 0 ? 0 : subLH}">${esc(line)}</tspan>`;
    });
    out += `</text>\n`;
  }

  // BODY POINTS
  if (bdy && (brief.body_points || []).length > 0) {
    let bY   = bdy.y_start != null ? bdy.y_start : Math.round(dim.h * 0.58);
    const bX = bdy.x != null ? bdy.x : margin;
    const bSize = bdy.size || 22;
    const bLH   = bdy.line_h || Math.round(bSize * 1.75);
    const pfx   = (!bdy.prefix || bdy.prefix === 'none') ? '' : bdy.prefix + ' ';
    brief.body_points.forEach(pt => {
      out += `<text x="${bX}" y="${bY}" font-family="${fontStack(bdy.font)}" font-size="${bSize}" font-weight="${bdy.weight || 400}" fill="${esc(bdy.color || '#AAAAAA')}" text-rendering="optimizeLegibility">${esc(pfx + pt)}</text>\n`;
      bY += bLH;
    });
  }

  // CTA BUTTON (rect + text)
  if (cta && cta.text && cta.x != null && cta.y != null) {
    const ctaSize = cta.size || 20;
    const padX    = cta.pad_x || 32;
    const padY    = cta.pad_y || 14;
    const btnW    = Math.round(cta.text.length * ctaSize * 0.56 + padX * 2);
    const btnH    = Math.round(ctaSize + padY * 2);
    const txtX    = Math.round(cta.x + btnW / 2);
    const txtY    = Math.round(cta.y + padY + ctaSize * 0.78);
    const bdr     = (cta.border_color && cta.border_color !== 'none')
      ? ` stroke="${esc(cta.border_color)}" stroke-width="1.5"` : '';
    out += `<rect x="${cta.x}" y="${cta.y}" width="${btnW}" height="${btnH}" rx="${cta.rx || 8}" fill="${esc(cta.bg_color || '#F5C518')}"${bdr}/>\n`;
    out += `<text x="${txtX}" y="${txtY}" text-anchor="middle" font-family="${fontStack(cta.font)}" font-size="${ctaSize}" font-weight="${cta.weight || 700}" fill="${esc(cta.color || '#000000')}">${esc(cta.text)}</text>\n`;
  }

  // FOOTER / HANDLE
  if (ft.handle) {
    const ftX    = ft.x != null ? ft.x : margin;
    const ftY    = Math.min(ft.y != null ? ft.y : dim.h - 28, dim.h - 12);
    const ftSize = ft.size || 18;
    out += `<text x="${ftX}" y="${ftY}" font-family="${fontStack(ft.font)}" font-size="${ftSize}" fill="${esc(ft.color || '#888888')}">${esc(ft.handle)}</text>\n`;
  }

  // DATA BLOCK (número hero)
  if (db && db.number) {
    const dbX     = db.x != null ? db.x : Math.round(dim.w * 0.55);
    const dbY     = db.y != null ? db.y : Math.round(dim.h * 0.30);
    const dbNSize = db.number_size || 120;
    if (db.bg_rect) {
      const br = db.bg_rect;
      out += `<rect x="${br.x}" y="${br.y}" width="${br.w}" height="${br.h}" rx="${br.rx || 8}" fill="${esc(br.color || '#333333')}" opacity="${br.opacity || 0.15}"/>\n`;
    }
    out += `<text x="${dbX}" y="${dbY}" font-family="${fontStack(db.number_font || 'Bebas Neue')}" font-size="${dbNSize}" fill="${esc(db.number_color || '#F5C518')}" text-anchor="middle" text-rendering="optimizeLegibility">${esc(db.number)}</text>\n`;
    if (db.label) {
      const lblY = Math.round(dbY + (db.label_size || 20) * 1.4);
      out += `<text x="${dbX}" y="${lblY}" font-family="${fontStack(db.label_font || 'DM Sans')}" font-size="${db.label_size || 20}" fill="${esc(db.label_color || '#AAAAAA')}" text-anchor="middle">${esc(db.label)}</text>\n`;
    }
  }

  // SLIDE INDICATOR
  if (si && si.text) {
    out += `<text x="${si.x || dim.w - margin}" y="${si.y || margin}" font-family="DM Sans,sans-serif" font-size="${si.size || 16}" fill="${esc(si.color || '#888888')}" text-anchor="${si.anchor || 'end'}">${esc(si.text)}</text>\n`;
  }

  out += '<!-- ╚══ FIM DO TEXTO PRÉ-CALCULADO ══╝ -->';
  return out;
}

// ── Estágio 3: SVG Decoration Artist ─────────────────────────────────────────
// Recebe blueprint (com texto já pré-renderizado) e adiciona decoração visual.
// Não posiciona texto — texto vem de buildTextElements() verbatim.
async function daStage3Svg({ brief, blueprint, brand, dim, format, network }) {
  const margin     = dim.w > 1200 ? 60 : 80;
  const deco       = blueprint._deco || {};
  const mood       = deco.mood || brief.visual_mood || 'dark-power';
  const layers     = deco.layers || ['radial-glow-center', 'noise-texture'];
  const sc         = deco.shape_count || 3;
  const bgColor    = blueprint.bg?.color     || brand.p2  || '#0D0D0F';
  const bgFrom     = blueprint.bg?.grad_from || bgColor;
  const bgTo       = blueprint.bg?.grad_to   || bgColor;
  const bgAngle    = blueprint.bg?.grad_angle || 135;
  const accentColor= brand.p1 || '#7C3AED';
  const glowColor  = blueprint.glow_color    || accentColor;

  const system =
`Você é o SVG DECORATION ARTIST — especialista em efeitos visuais, atmosfera e profundidade.
Os elementos de texto já estão pré-renderizados e serão inseridos exatamente como estão.
SUA ÚNICA MISSÃO: adicionar fundo, atmosfera e decoração visual de nível agência internacional.

═══════════ LEIS ABSOLUTAS ═══════════
1. Retorne APENAS o SVG — começa com <svg, termina com </svg>. Zero texto antes/depois.
2. xmlns="http://www.w3.org/2000/svg" e viewBox="0 0 ${dim.w} ${dim.h}" OBRIGATÓRIOS na tag <svg>.
3. width="${dim.w}" height="${dim.h}" na tag <svg>.
4. <clipPath id="canvas"><rect width="${dim.w}" height="${dim.h}"/></clipPath> em defs.
   Envolva TODO conteúdo (exceto rect base) em <g clip-path="url(#canvas)">.
5. NUNCA use <image href="http..."> — zero recursos externos.
6. NUNCA modifique o bloco de texto pré-renderizado — copie verbatim.

═══════════ FONTES ═══════════
"Bebas Neue" | "Syne" | "DM Sans" | "Playfair Display" | "Cormorant Garamond" | "IBM Plex Mono"

═══════════ TEMPLATE ATIVO: ${blueprint._templateName || blueprint._templateId} ═══════════
Mood: ${mood} | Layers ativos: ${layers.join(', ')} | Mín. shapes: ${sc}
Gradiente: ${deco.has_gradient ? 'SIM' : 'NÃO'} | Glow: ${deco.has_glow ? 'SIM' : 'NÃO'} | Pattern: ${deco.has_pattern ? 'SIM' : 'NÃO'}

═══════════ DICIONÁRIO DE LAYERS (implemente cada um listado acima) ═══════════
radial-glow-center    → <radialGradient cx="50%" cy="40%" r="55%"> accentColor→transparent; rect fullscreen fill=url() opacity implícita no stop
radial-glow-cta       → mesmo, mas cy="75%" r="40%"
gradient-dramatic     → linearGradient diagonal ${bgFrom}→${bgTo} em rect fullscreen
gradient-top-bottom   → linearGradient y1="0%" y2="100%" ${bgFrom}→${bgTo}
noise-texture         → <filter><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3"/><feBlend mode="overlay"/></filter> rect opacity:0.04
grain-texture         → <filter><feTurbulence type="fractalNoise" baseFrequency="0.80" numOctaves="4"/><feColorMatrix type="saturate" values="0"/></filter> rect opacity:0.06
grid-pattern          → <pattern width="40" height="40"> path grid </pattern> rect fullscreen opacity:0.04
subtle-bg-lighter     → rect fullscreen fill="${bgFrom}" opacity="0.05"
accent-rule-left      → <rect x="${Math.round(dim.w*0.07)}" y="${Math.round(dim.h*0.15)}" width="3" height="${Math.round(dim.h*0.25)}" fill="accentColor"/>
accent-rule-top       → <rect x="${Math.round(dim.w*0.07)}" y="${Math.round(dim.h*0.08)}" width="${Math.round(dim.w*0.12)}" height="2" fill="accentColor"/>
separator-h           → <line x1="${margin}" y1="${Math.round(dim.h*0.70)}" x2="${dim.w-margin}" y2="${Math.round(dim.h*0.70)}" stroke="p4" opacity="0.25"/>
separator-h-thin      → mesmo em y="${Math.round(dim.h*0.30)}" opacity="0.15"
separator-h-after-hl  → line horizontal logo abaixo do headline, p4 opacity:0.20
separator-h-above-cta → line horizontal y="${Math.round(dim.h*0.72)}" p4 opacity:0.20
accent-diagonal       → <polygon points="${dim.w-150},0 ${dim.w},0 ${dim.w},150" fill="accentColor" opacity="0.20"/>
corner-brackets       → 4 L-brackets 60px nos cantos (<path d="M x y L..."/>) stroke=accentColor stroke-width=2 opacity:0.40
corner-accents        → igual corner-brackets
corner-frame          → <rect x="${margin}" y="${margin}" width="${dim.w-margin*2}" height="${dim.h-margin*2}" rx="4" fill="none" stroke="p4" opacity="0.20"/>
inner-frame-rect      → <rect x="${Math.round(dim.w*0.05)}" y="${Math.round(dim.h*0.05)}" width="${Math.round(dim.w*0.90)}" height="${Math.round(dim.h*0.90)}" fill="none" stroke="accentColor" stroke-width="1.5"/>
accent-circle-bg      → <circle cx="${Math.round(dim.w*0.85)}" cy="${Math.round(dim.h*0.35)}" r="${Math.round(dim.w*0.30)}" fill="accentColor" opacity="0.08"> + <filter><feGaussianBlur stdDeviation="40"/></filter>
glow-behind           → <circle cx="${Math.round(dim.w*0.50)}" cy="${Math.round(dim.h*0.40)}" r="${Math.round(dim.w*0.25)}" fill="glowColor" opacity="0.20"> + blur filter std=30
blur-orb-bg           → 2 circles blur: 30%/40%/30% e 70%/60%/25% do canvas, accentColor opacity:0.18
accent-shape-abstract → polygon ou path abstrato accentColor opacity:0.15
accent-burst          → círculos concêntricos cx=75% cy=80% accentColor opacity:0.10
badge-count           → rect arredondado no canto sup-dir com texto do slide_indicator
micro-label-above     → pequeno texto "— INSIGHT" acima do headline, p4 opacity:0.50
subtle-glow-top       → radialGradient cx=50% cy=0% r=50% accentColor stop-opacity=0.15 em rect
accent-bar-left-full  → <rect x="${Math.round(dim.w*0.07)}" y="0" width="5" height="${dim.h}" fill="accentColor" opacity="0.75"/> — barra vertical dominante à esquerda
accent-rule-bottom-sym → <rect x="${dim.w-margin-Math.round(dim.w*0.18)}" y="${Math.round(dim.h*0.88)}" width="${Math.round(dim.w*0.18)}" height="2" fill="accentColor"/> — linha simétrica inferior direita
radial-glow-top-left  → radialGradient cx="15%" cy="15%" r="55%"> accentColor→transparent; rect fullscreen fill=url() opacity via stop
large-quote-marks     → <text x="${Math.round(dim.w*0.07)}" y="${Math.round(dim.h*0.36)}" font-family="Playfair Display,Georgia,serif" font-size="180" fill="accentColor" opacity="0.22">"</text> — aspas gigantes decorativas à esquerda
horizontal-split-divider → <line x1="${margin}" y1="${Math.round(dim.h*0.50)}" x2="${dim.w-margin}" y2="${Math.round(dim.h*0.50)}" stroke="accentColor" opacity="0.40" stroke-width="1.5"/> — divisor horizontal no meio
accent-tone-bottom-half  → <rect x="0" y="${Math.round(dim.h*0.50)}" width="${dim.w}" height="${Math.round(dim.h*0.50)}" fill="accentColor" opacity="0.05"/> — tom de cor sutil na metade inferior

═══════════ ESTRUTURA DO SVG (siga exatamente) ═══════════
<svg xmlns="http://www.w3.org/2000/svg" width="${dim.w}" height="${dim.h}" viewBox="0 0 ${dim.w} ${dim.h}">
<defs>
  <clipPath id="canvas"><rect width="${dim.w}" height="${dim.h}"/></clipPath>
  <!-- todos gradientes, filtros e patterns aqui -->
</defs>
<rect width="${dim.w}" height="${dim.h}" fill="${bgColor}"/>
<g clip-path="url(#canvas)">
  <!-- CAMADA 2: gradiente de fundo (se has_gradient) -->
  <!-- CAMADA 3: atmosfera — noise/grain/grid/glow (se has_pattern ou has_glow) -->
  <!-- CAMADA 4: shapes decorativos — mínimo ${sc} elementos dos layers acima -->
  <!-- CAMADA 5: accent elements — linhas, frames, separadores, brackets -->

  <!-- ↓ BLOCO DE TEXTO PRÉ-RENDERIZADO — COPIE VERBATIM, SEM ALTERAR NADA ↓ -->
  <!-- ↑ FIM DO BLOCO DE TEXTO ↑ -->

  <!-- CAMADA 7: overlay leve final (vignette, scanlines) -->
</g>
</svg>

CHECKLIST FINAL:
✓ Mínimo ${sc} shapes decorativos implementados
✓ 1+ gradiente (linear ou radial)
✓ 1+ filtro feGaussianBlur (profundidade premium)
✓ Shapes com opacity 0.04–0.30 (não competem com texto)
✓ Bloco de texto copiado verbatim (nem um caractere alterado)`;

  const preBuiltText = buildTextElements({ brief, blueprint, dim, margin });

  const r = await callClaude({
    system,
    userMsg: `Plataforma: ${DA_NET_LABELS[network]||network} | Canvas: ${dim.w}×${dim.h}px | Mood: ${mood}
BG: ${bgColor} | Accent: ${accentColor} | Glow: ${glowColor}
Camadas ativas: ${(() => { const bp = brief._blueprint; const l = []; l.push('fundo', 'glow', 'decoração', 'ruído', 'texto'); if (bp?.visual?.image_usage === 'dominant' || bp?.visual?.image_usage === 'subtle') l.push('imagem'); return l.join(', '); })()}

BLOCO DE TEXTO PRÉ-RENDERIZADO — copie verbatim na Camada 6, sem alterar nenhum caractere:
${preBuiltText}

Construa o SVG completo agora. Substitua o comentário da Camada 6 pelo bloco acima:`,
    maxTokens: 6000,
  });

  let svg = '';
  const m = r.text.match(/<svg[\s\S]*<\/svg>/i);  // greedy: from first <svg to last </svg>
  if (m) svg = m[0];
  else if (r.text.trim().startsWith('<svg')) svg = r.text.trim();
  if (svg && !svg.includes('xmlns='))
    svg = svg.replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg"`);
  if (svg && !svg.includes('viewBox'))
    svg = svg.replace('<svg', `<svg viewBox="0 0 ${dim.w} ${dim.h}"`);
  return { svg: sanitizeSvg(svg), tok: { in: r.inputTokens, out: r.outputTokens } };
}

// ── Rotas: Designs Salvos ─────────────────────────────────────────────────────

route('POST', '/api/user/designs/save', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { svg, prompt, format, network, voice_id, voice_name } = await parseBody(req);
  if (!svg || svg.length < 100) return err(res, 'SVG inválido ou ausente');
  const id = db.saveDesign({ user_id: payload.id, svg, prompt, format, network, voice_id, voice_name });
  ok(res, { id, message: 'Design salvo com sucesso!' });
});

route('GET', '/api/user/designs/saved', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const designs = db.getSavedDesigns({ user_id: payload.id, limit: 100 });
  ok(res, { designs });
});

route('GET', '/api/user/designs/:id', async (req, res, params) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const design = db.getSavedDesignSvg(params.id, payload.id);
  if (!design) return err(res, 'Design não encontrado', 404);
  ok(res, { design });
});

route('DELETE', '/api/user/designs/:id', async (req, res, params) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const deleted = db.deleteSavedDesign(params.id, payload.id);
  if (!deleted) return err(res, 'Design não encontrado ou sem permissão', 404);
  ok(res, { message: 'Design removido dos favoritos.' });
});

// ── Tweet Card: gerador determinístico (sem IA para o layout) ────────────────
// Stage 1 já extraiu o conteúdo. Aqui construímos o SVG pixel a pixel em JS.
// Vantagens: logo real, nome/handle corretos, layout consistente, zero tokens de layout.
function _buildTweetCardSvg({ brief, brand, dim }) {
  const W = dim.w, H = dim.h;
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const pad  = Math.round(W * 0.056);   // ~60px at 1080

  // ── helpers ─────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function wrap(text, maxPx, fs, ratio) {
    ratio = ratio || 0.52;
    const maxC = Math.max(1, Math.floor(maxPx / (fs * ratio)));
    const words = String(text || '').split(' ');
    const lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (t.length <= maxC) { cur = t; }
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function mtext(lines, x, baseY, fs, lh, extraAttrs) {
    if (!lines || !lines.length) return '';
    const a = extraAttrs || '';
    return `<text x="${x}" y="${baseY}" font-family="${FONT}" font-size="${fs}" ${a}>`
      + lines.map((l, i) => `<tspan x="${x}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('')
      + '</text>';
  }

  // ── content ──────────────────────────────────────────────────────────────────
  const authorName = (brand.nome || brand.profissao || 'Marca').slice(0, 32);
  const initials   = authorName.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
  const rawHandle  = brand.tweetHandle || brand.handle || authorName.split(' ')[0].toLowerCase();
  const handleStr  = '@' + rawHandle.replace(/^@/, '');
  const dateStr    = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const viewsStr   = String(brief.data_highlight || '12.4k');

  // ── geometry ──────────────────────────────────────────────────────────────────
  const contentW = W - pad * 2;

  // Header
  const aR  = Math.round(W * 0.033);    // ~36px at 1080 — avatar radius
  const aTopPad = Math.round(H * 0.056);
  const aCx = pad + aR;
  const aCy = aTopPad + aR;

  const nameX  = aCx + aR + 16;
  const nameY  = aCy - 9;
  const hdleY  = aCy + 18;

  // X.com label — far right, vertically centred on avatar
  const xcX = W - pad;
  const xcY = aCy + 10;

  // Tweet text (large)
  const FS_TWEET = Math.round(W * 0.033);  // ~36px at 1080
  const LH_TWEET = Math.round(FS_TWEET * 1.42);
  const tweetTextX = pad;
  const tweetTextY = aCy + aR + Math.round(H * 0.046);

  const tweetLines = wrap(brief.headline || '', contentW, FS_TWEET, 0.50);
  let curY = tweetTextY + tweetLines.length * LH_TWEET;

  // Subheadline (optional, slightly smaller, gray)
  const FS_SUB = Math.round(FS_TWEET * 0.70);
  const LH_SUB = Math.round(FS_SUB * 1.4);
  const subLines = brief.subheadline ? wrap(brief.subheadline, contentW, FS_SUB, 0.50) : [];
  let subBase = 0;
  if (subLines.length) {
    curY += Math.round(H * 0.018);
    subBase = curY + FS_SUB;
    curY = subBase + (subLines.length - 1) * LH_SUB + Math.round(H * 0.022);
  }

  // Date + views
  const FS_DATE = Math.round(W * 0.017);  // ~18px at 1080
  curY += Math.round(H * 0.018);
  const dateY = curY + FS_DATE;
  curY = dateY + Math.round(H * 0.032);

  // Divider
  const divY = curY;
  curY += Math.round(H * 0.028);

  // Icons row
  const FS_ICON = Math.round(W * 0.016);
  const iconsY  = curY + Math.round(H * 0.028);

  // ── SVG assembly ──────────────────────────────────────────────────────────────
  let defs = '';
  let body = '';

  defs += `<clipPath id="tcCv"><rect width="${W}" height="${H}"/></clipPath>`;
  if (brand.logo) defs += `<clipPath id="tcAvClip"><circle cx="${aCx}" cy="${aCy}" r="${aR}"/></clipPath>`;

  // White background — full bleed
  body += `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`;

  // ── Header ────────────────────────────────────────────────────────────────────
  // Avatar
  if (brand.logo) {
    body += `<image href="${brand.logo}" x="${aCx - aR}" y="${aCy - aR}" width="${aR * 2}" height="${aR * 2}" clip-path="url(#tcAvClip)" preserveAspectRatio="xMidYMid slice"/>`;
    body += `<circle cx="${aCx}" cy="${aCy}" r="${aR}" fill="none" stroke="#CFD9DE" stroke-width="1.5"/>`;
  } else {
    body += `<circle cx="${aCx}" cy="${aCy}" r="${aR}" fill="#1D9BF0"/>`;
    body += `<text x="${aCx}" y="${aCy + Math.round(aR * 0.33)}" text-anchor="middle" font-family="${FONT}" font-size="${Math.round(aR * 0.72)}" font-weight="700" fill="#FFFFFF">${esc(initials)}</text>`;
  }

  // Name
  const nameFS = Math.round(W * 0.018);
  body += `<text x="${nameX}" y="${nameY}" font-family="${FONT}" font-size="${nameFS}" font-weight="700" fill="#0F1419">${esc(authorName)}</text>`;

  // Verified badge — Twitter blue circle with white checkmark
  const vbOff  = Math.min(authorName.length * nameFS * 0.55, contentW * 0.55);
  const vbCx   = nameX + vbOff + nameFS * 0.9;
  const vbCy   = nameY - nameFS * 0.44;
  const vbR    = Math.round(nameFS * 0.52);
  body += `<circle cx="${vbCx}" cy="${vbCy}" r="${vbR}" fill="#1D9BF0"/>`;
  body += `<path d="M${vbCx - vbR * 0.48} ${vbCy} l${vbR * 0.44} ${vbR * 0.44} l${vbR * 0.7} ${-vbR * 0.66}" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Handle
  const hdleFS = Math.round(W * 0.015);
  body += `<text x="${nameX}" y="${hdleY}" font-family="${FONT}" font-size="${hdleFS}" fill="#536471">${esc(handleStr)}</text>`;

  // "X.com" — bold, top-right
  const xcFS = Math.round(W * 0.022);
  body += `<text x="${xcX}" y="${xcY}" text-anchor="end" font-family="${FONT}" font-size="${xcFS}" font-weight="800" fill="#0F1419">X.com</text>`;

  // ── Tweet text ────────────────────────────────────────────────────────────────
  body += mtext(tweetLines, tweetTextX, tweetTextY, FS_TWEET, LH_TWEET, 'font-weight="400" fill="#0F1419"');

  // Subheadline (optional)
  if (subLines.length) {
    body += mtext(subLines, tweetTextX, subBase, FS_SUB, LH_SUB, 'fill="#536471"');
  }

  // Date + views — plain gray
  body += `<text x="${pad}" y="${dateY}" font-family="${FONT}" font-size="${FS_DATE}" fill="#536471">${esc(dateStr)} · ${esc(viewsStr)} Views</text>`;

  // Single thin divider
  body += `<line x1="${pad}" y1="${divY}" x2="${W - pad}" y2="${divY}" stroke="#EFF3F4" stroke-width="1.5"/>`;

  // ── Icons row (Reply · Retweet · Heart · Bookmark · Share) ───────────────────
  const iSpan = Math.floor(contentW / 5);
  const iS    = ((aR * 0.56) / 12).toFixed(4);   // scale 24px paths to ~aR*0.56
  const iItems = [
    // Reply
    { d: 0,
      path: 'M1.751 10c0-3.836 3.153-7 7.044-7 1.923 0 3.675.792 4.965 2.07a6.98 6.98 0 0 1 2.04 4.93v.602h-2.008V10c0-2.76-2.236-5-4.997-5s-5 2.24-5 5 2.239 5 5 5h.625v2h-.625C4.904 17 1.751 13.836 1.751 10Z',
      c: '#536471' },
    // Retweet
    { d: iSpan,
      path: 'M4.5 3.88l-1.87 1.85.99 1 1.85-1.83V12h1.4V4.9l1.85 1.83.99-1L7.85 3.88a.95.95 0 0 0-1.35 0ZM19.5 12.12l1.87-1.85-.99-1-1.85 1.83V5h-1.4v7.1l-1.85-1.83-.99 1 1.87 1.85c.37.37.98.37 1.34 0Z',
      c: '#536471' },
    // Heart
    { d: iSpan * 2,
      path: 'M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91Z',
      c: '#F91880' },
    // Bookmark
    { d: iSpan * 3,
      path: 'M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.044l-8-5.787-8 5.787V4.5Z',
      c: '#536471' },
    // Share
    { d: iSpan * 4,
      path: 'M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h13c.28 0 .5-.22.5-.5V15h2z',
      c: '#536471' },
  ];

  const iconSize = aR * 0.56 * 2;  // rendered icon size in px
  for (const ic of iItems) {
    const ix2 = pad + ic.d + Math.floor((iSpan - iconSize) / 2);
    const iy2 = iconsY - iconSize;
    body += `<g transform="translate(${ix2},${iy2}) scale(${iS})"><path d="${ic.path}" fill="${ic.c}"/></g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs><g clip-path="url(#tcCv)">${body}</g></svg>`;
}

async function daStage3Tweet({ brief, brand, dim }) {
  const svg = _buildTweetCardSvg({ brief, brand, dim });
  return { svg, tok: { in: 0, out: 0 } };
}

// ── Rota: Variações — gera N alternativas visuais em paralelo ────────────────
// Roda 1 Brief Analyst compartilhado + N Art Director/SVG Executor em paralelo.
// Cada variação recebe um visual_mood diferente para máxima diversidade.
// Quota: 1 crédito por variação gerada com sucesso.
route('POST', '/api/user/design-agent/variations', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { prompt, format = 'post', network = 'instagram', brandProfile, count = 2, postFormat } = await parseBody(req);
  if (!prompt) return err(res, 'prompt obrigatório');

  const user    = db.getUserById(payload.id);
  const brand   = daBrand(user, brandProfile);
  const dim     = DA_DIMS[format] || DA_DIMS.post;
  const n       = Math.max(2, Math.min(3, parseInt(count) || 2));
  const isTweet = postFormat === 'tweet';

  // Consome n créditos antecipadamente
  try { for (let i = 0; i < n; i++) db.consumeQuota(payload.id); }
  catch(e) { return err(res, e.message, 402); }

  // Estágio 1 compartilhado — brief único para todas as variações
  let brief, s1Tok = { in: 0, out: 0 };
  try {
    const s1 = await daStage1Brief({ prompt, format, network, brand });
    brief  = s1.data;
    s1Tok  = s1.tok;
  } catch(e) { return err(res, 'Falha na análise: ' + e.message); }

  // Visual moods distintos para garantir diversidade visual entre variações
  const VARIATION_MOODS = ['dark-power', 'clean-premium', 'bold-energy'];

  // Estágios 2+3 em paralelo — cada variação com mood diferente
  const tasks = Array.from({ length: n }, (_, i) => {
    const moodBrief = { ...brief, visual_mood: VARIATION_MOODS[i % VARIATION_MOODS.length] };
    const taskPromise = isTweet
      ? daStage3Tweet({ brief: moodBrief, brand, dim })
          .then(s3 => ({ s2: { tok: { in: 0, out: 0 } }, s3 }))
      : daStage2ArtDir({ brief: moodBrief, brand, dim, format, slideIndex: null, totalSlides: null, network })
          .then(s2 => daStage3Svg({ brief: moodBrief, blueprint: s2.data, brand, dim, format, network })
            .then(s3 => ({ s2, s3 })));
    return taskPromise
      .then(({ s2, s3 }) => ({
          index: i + 1,
          tok: { in: (s2.tok.in||0) + (s3.tok.in||0), out: (s2.tok.out||0) + (s3.tok.out||0) },
        }))
      .catch(e => ({ index: i + 1, mood: VARIATION_MOODS[i % VARIATION_MOODS.length], svg: null, ok: false, error: e.message, tok: { in: 0, out: 0 } }));
  });

  const results = await Promise.all(tasks);

  // Persiste apenas as variações bem-sucedidas (Stage 1 tokens divididos igualmente)
  const s1PerVar = { in: Math.round((s1Tok.in||0) / n), out: Math.round((s1Tok.out||0) / n) };
  for (const r of results) {
    if (r.ok && r.svg) {
      db.addGeneration({
        user_id: payload.id, feature: 'design-agent-variation',
        format, network, concept_name: (brief.headline || prompt).slice(0, 60),
        prompt: prompt.slice(0, 200), svg_data: r.svg, credits_used: 1,
        input_tokens:  (r.tok?.in  || 0) + s1PerVar.in,
        output_tokens: (r.tok?.out || 0) + s1PerVar.out,
      });
    }
  }

  log.info(`[VARIATIONS] user=${payload.id} n=${n} ok=${results.filter(r=>r.ok).length}/${n}`);
  ok(res, { variations: results, brief, total: n });
});

// ── Rota: Planejador de Carrossel ─────────────────────────────────────────────
// Gera o plano narrativo completo antes de gerar os slides individualmente.
// O cliente usa o plano para passar slideRole em cada chamada do design-agent.
route('POST', '/api/user/design-agent/plan-carousel', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { prompt, totalSlides = 5, network = 'instagram', brandProfile } = await parseBody(req);
  if (!prompt) return err(res, 'prompt obrigatório');

  const user  = db.getUserById(payload.id);
  const brand = daBrand(user, brandProfile);
  const n     = Math.max(3, Math.min(10, parseInt(totalSlides) || 5));
  const netLabel = DA_NET_LABELS[network] || network;

  const system =
`Você é o CAROUSEL PLANNER — especialista em narrativa visual para carrosseis que convertem.
MISSÃO: Criar o plano narrativo completo de ${n} slides. Cada slide cria desejo pelo próximo.

MARCA: profissão=${brand.profissao} | nicho=${brand.nicho} | tom=${brand.tom} | público=${brand.publico}
PLATAFORMA: ${netLabel}

ESTRUTURA OBRIGATÓRIA:
• SLIDE 1 (CAPA): Para o scroll. Promessa irresistível. Máximo impacto visual.
• SLIDES 2–${n - 1} (DESENVOLVIMENTO): Uma ideia poderosa por slide. Progressão lógica.
• SLIDE ${n} (CTA): Fechamento com transformação + ação clara.

REGRAS:
• Headline máx 7 palavras — específico e real
• Subheadline máx 12 palavras
• Body points: máx 3 itens de máx 6 palavras
• data_highlight: número/dado impactante ou null
• CTA máx 4 palavras
• visual_note: instrução para o designer (mood, elemento de destaque)
• Cada slide deve ter CONTEÚDO DIFERENTE — não repita ideias

RETORNE SOMENTE JSON VÁLIDO:
{
  "theme": "tema central do carrossel",
  "narrative_arc": "descrição do arco em 1 frase",
  "slides": [
    {
      "slide_number": 1,
      "role": "capa | desenvolvimento | revelação | virada | cta",
      "headline": "string",
      "subheadline": "string ou null",
      "body_points": [],
      "data_highlight": "string ou null",
      "cta": "string",
      "visual_note": "string"
    }
  ]
}`;

  try {
    const r = await callClaude({
      system,
      userMsg: `TEMA: "${prompt}"\nSLIDES: ${n}\nPlataforma: ${netLabel}\n\nCrie o plano narrativo completo:`,
      maxTokens: 2500,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    const plan = JSON.parse(m[0]);
    ok(res, { plan, totalSlides: n });
  } catch(e) { err(res, 'Falha ao gerar plano: ' + e.message); }
});

// ── Rota: Design Agent SSE ────────────────────────────────────────────────────
// Pipeline completo: Brief → Art Direction → SVG
// Eventos SSE: stage | brief | blueprint | done | error
route('POST', '/api/user/design-agent', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const {
    prompt, format = 'post', network = 'instagram', brandProfile,
    slideIndex, totalSlides, slideRole, postFormat,
    blueprint, subFormat,
  } = await parseBody(req);

  if (!prompt) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'prompt obrigatório' }));
  }

  const user      = db.getUserById(payload.id);
  const brand     = daBrand(user, brandProfile);
  const dim       = DA_DIMS[format] || DA_DIMS.post;
  const isCarrossel = format === 'carrossel';
  const isTweetFmt  = postFormat === 'tweet';
  const slideIdx  = Math.max(1, parseInt(slideIndex) || 1);
  const totalSl   = Math.max(1, parseInt(totalSlides) || 1);

  // Quota: tweet=4cr | padrão/carrossel=2cr por slide (2sl=4cr,3sl=6cr,...7sl=14cr)
  {
    const credits = isTweetFmt ? 4 : 2;
    try { for (let i = 0; i < credits; i++) db.consumeQuota(payload.id); }
    catch(e) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  });

  const send = (type, data) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  };

  // Keepalive: send SSE comment every 8s to prevent proxy timeouts (design agent can take 60-90s)
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 8000);

  let totalIn = 0, totalOut = 0;
  const isTweet = isTweetFmt;

  try {
    // ── Estágio 1: Brief Analysis ──────────────────────────────────────────
    send('stage', { stage: 1, total: isTweet ? 2 : 3, label: 'Analisando conteúdo...', pct: 8 });

    const s1 = await daStage1Brief({ prompt, format, network, brand, slideRole, blueprint, slideIndex: slideIdx, subFormat });
    totalIn  += s1.tok.in;
    totalOut += s1.tok.out;

    send('brief', { brief: s1.data });
    send('stage', { stage: 1, total: isTweet ? 2 : 3, label: 'Conteúdo estruturado ✓', pct: 30 });

    let svgResult;

    if (isTweet) {
      // ── Tweet Format: Stage 2 bypassed — SVG determinístico ───────────────
      send('stage', { stage: 2, total: 2, label: 'Gerando tweet card...', pct: 55 });
      svgResult = await daStage3Tweet({ brief: s1.data, brand, dim });
    } else {
      // ── Estágio 2: Art Direction ─────────────────────────────────────────
      send('stage', { stage: 2, total: 3, label: 'Definindo direção de arte...', pct: 32 });
      const s2 = await daStage2ArtDir({
        brief: s1.data, brand, dim, format, slideIndex: slideIdx, totalSlides: totalSl, slideRole, network, subFormat,
      });
      totalIn  += s2.tok.in;
      totalOut += s2.tok.out;
      send('blueprint', { blueprint: s2.data });
      send('stage',     { stage: 2, total: 3, label: 'Blueprint definido ✓', pct: 55 });

      // ── Estágio 3: SVG Execution ───────────────────────────────────────────
      send('stage', { stage: 3, total: 3, label: 'Executando design...', pct: 60 });
      svgResult = await daStage3Svg({
        brief: s1.data, blueprint: s2.data, brand, dim, format, network,
      });
    }

    totalIn  += svgResult.tok.in;
    totalOut += svgResult.tok.out;
    const s3 = svgResult;

    if (!s3.svg || s3.svg.length < 300) throw new Error('SVG inválido gerado. Tente novamente.');

    // ── Persiste geração ───────────────────────────────────────────────────
    const costUsd = parseFloat(((totalIn / 1_000_000 * 3) + (totalOut / 1_000_000 * 15)).toFixed(6));
    const gen = db.addGeneration({
      user_id:      payload.id,
      feature:     'design-agent',
      format,
      network,
      concept_name: (s1.data.headline || prompt).slice(0, 60),
      prompt:       prompt.slice(0, 200),
      svg_data:     s3.svg,
      credits_used: 1,
      input_tokens:  totalIn,
      output_tokens: totalOut,
    });

    send('done', {
      svg:          s3.svg,
      brief:        s1.data,
      blueprint:    isTweet ? null : undefined,
      generation_id: gen.id,
      tokens:       { input: totalIn, output: totalOut },
      cost_usd:     costUsd,
      pct:          100,
    });

    log.info(`[DESIGN-AGENT] user=${payload.id} format=${format} tokens=${totalIn + totalOut} cost=$${costUsd}`);

  } catch(e) {
    log.error('[DESIGN-AGENT] Error:', e.message);
    send('error', { message: e.message });
  } finally {
    clearInterval(keepalive);
  }

  res.end();
});

// ── Rota: Brainstorm conversacional ──────────────────────────────────────────
// Permite o usuário desenvolver a ideia em conversa com a IA antes de gerar.
// Cada mensagem consome 1 crédito. Suporta até 14 mensagens de histórico.
route('POST', '/api/user/brainstorm', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { messages, context, brandProfile, format, network } = await parseBody(req);
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return err(res, 'messages obrigatório');

  const user = db.getUserById(payload.id);
  try { db.consumeQuota(payload.id); } catch(e) { return err(res, e.message, 402); }

  const brand = daBrand(user, brandProfile);

  const ctxLabel = {
    image: 'post visual / imagem de marketing',
    legenda: 'legenda para redes sociais',
    'roteiro-yt': 'roteiro para YouTube',
    'roteiro-reels': 'roteiro para Reels/TikTok',
    story: 'ideias para Stories',
    linkedin: 'post profissional para LinkedIn',
    tiktok: 'roteiro e hook para TikTok',
  }[context] || context || 'conteúdo de marketing';

  const fmtLabel = { post: 'Post único', carrossel: 'Carrossel', story: 'Story', anuncio: 'Anúncio',
    thumb: 'Thumbnail', banner: 'Banner', reels: 'Reels', tweet: 'Tweet Card' }[format] || (format || 'não especificado');
  const netLabel = { ig: 'Instagram', li: 'LinkedIn', yt: 'YouTube', tt: 'TikTok', fb: 'Facebook',
    instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok' }[network] || (network || 'não especificado');
  const fmtCtx = (format || network)
    ? `\nFORMATO SELECIONADO: ${fmtLabel} | REDE: ${netLabel}`
    : '\nFORMATO/REDE: ainda não selecionados pelo usuário';

  const system =
`Você é o estrategista criativo da Autopostt.
Sem formalidade, sem consultoria, sem rodeios.
Fale como um amigo que entende muito de conteúdo — direto, específico, humano.

MARCA: ${brand.profissao} | Nicho: ${brand.nicho} | Tom: ${brand.tom} | Público: ${brand.publico}${fmtCtx}

━━━ COMO VOCÊ AGE ━━━

Você fica no tópico que o usuário trouxe — sempre.
"Burnout em vendas" → você fala de burnout em vendas. Nunca muda para burnout em conteúdo, nunca generaliza.
"Produtividade matinal" → produtividade matinal. Não "bem-estar" nem "rotina". As palavras exatas do usuário.

Você espelha o jeito que a pessoa escreve.
Se veio curto e direto, responde curto e direto.
Se veio técnico, vai fundo no técnico.
Gíria, informalidade — tudo certo. Nunca seja mais "consultor" do que a pessoa foi.

Você vai direto ao ponto — máx 4-5 linhas.
Sem "ótima ideia!", sem elogios, sem introdução. Já começa no conteúdo.
Entendeu o tópico → propôs ângulo específico → (1 pergunta se precisar).

Se precisar perguntar, faz uma pergunta só — a mais cirúrgica.

Quando propor um ângulo, traduz em 1-2 headlines visuais (máx 8 palavras cada).
Ex: ângulo "meta impossível que queima vendedor em 6 meses"
→ "Sua meta foi desenhada para te quebrar"
→ "A meta impossível que queima quem vende"
Isso mostra o post antes de existir. A headline para o scroll.

Use busca na web quando precisar de dado real sobre o tópico exato.
Busca específica: "burnout rotatividade vendedores Brasil 2024" — não "o que é burnout".
Máx 2 buscas. Não busque o que você já sabe.

━━━ QUANDO ENCERRAR ━━━
Coloque ✅ quando o ângulo estiver claro + tiver elemento concreto (dado, contraste, transformação real).
Use 🔄 quando ainda precisar de detalhe ou clareza no ângulo.
Quando ✅: "Tá bom — clica em ✦ Refinar Prompt para gerar."`;

  try {
    const r = await callClaudeMessagesWithSearch({
      system,
      messages: messages.slice(-14).map(m => ({ role: m.role, content: String(m.content) })),
      maxTokens: 600,
    });
    const tok = { in: r.inputTokens || 0, out: r.outputTokens || 0 };
    const cost_usd = parseFloat(((tok.in / 1_000_000 * 3) + (tok.out / 1_000_000 * 15)).toFixed(6));
    res.end(JSON.stringify({ ok: true, reply: r.text, tok, cost_usd }));
  } catch(e) {
    return err(res, 'Erro na conversa: ' + e.message);
  }
});

// ── Rota: Refinar prompt a partir de uma conversa ─────────────────────────────
// Consolida o histórico de brainstorm em um prompt rico e específico. +1 crédito.
route('POST', '/api/user/brainstorm/refine', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { messages, context, brandProfile, format, network } = await parseBody(req);
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return err(res, 'messages obrigatório');

  const user = db.getUserById(payload.id);
  try { db.consumeQuota(payload.id); } catch(e) { return err(res, e.message, 402); }

  const brand = daBrand(user, brandProfile);

  const ctxType = {
    image: 'post visual de marketing digital',
    legenda: 'legenda para redes sociais',
    'roteiro-yt': 'roteiro completo para YouTube',
    'roteiro-reels': 'roteiro de Reels/TikTok',
    story: 'sequência de Stories',
    linkedin: 'post profissional para LinkedIn',
    tiktok: 'roteiro e hook para TikTok',
  }[context] || context || 'conteúdo digital';

  const conversationStr = messages
    .slice(-16)
    .map(m => `${m.role === 'user' ? 'Usuário' : 'Consultor'}: ${m.content}`)
    .join('\n\n');

  const system =
`You are a prompt refiner specialized in extracting structured intent from conversations.

Your job is to analyze the FULL conversation between the user and the Creative Strategist and convert it into a clean, structured base for visual generation.

IMPORTANT:
- Do NOT decide format
- Do NOT decide visual style
- Do NOT add creative ideas
- Only extract and organize

GOAL:
Create a clear content foundation that can later be adapted into different formats and styles.

RULES:
- Capture the real intention of the content
- Remove repetition and noise
- Keep it concise
- Focus on what will be VISUALIZED

OUTPUT FORMAT:

CORE_MESSAGE:
(what is the main idea)

HEADLINE_OPTIONS:
(3–5 short options, max 8 words each)

CONTENT_POINTS:
(key ideas or steps, bullet format)

EMOTION:
(desired feeling)

AUDIENCE:
(target audience)

GOAL:
(engagement | authority | sales)

CONSTRAINTS:
- simple
- clear
- visual-friendly

RULE:
Do not format into slides.
Do not define layout.
This is a neutral base.

LANGUAGE: Respond in the SAME language as the conversation (if Portuguese, write in Portuguese; if English, write in English).`;

  try {
    const r = await callClaudeMessages({
      system,
      messages: [{ role: 'user', content: `Conversa completa:\n\n${conversationStr}\n\nExtraia a base estruturada:` }],
      maxTokens: 800,
    });
    const tok = { in: r.inputTokens || 0, out: r.outputTokens || 0 };
    res.end(JSON.stringify({ ok: true, refinedPrompt: r.text.trim(), blueprint: null, tok }));
  } catch(e) {
    return err(res, 'Erro ao refinar: ' + e.message);
  }
});

// ── Rota: Refinar para formato e tom de marca (Refinador #2) ──────────────────
// Recebe a base do Refinador #1 + formato + tom de marca e produz um blueprint JSON.
route('POST', '/api/user/brainstorm/refine-format', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { refineBase, format, subFormat, network, voiceName, brandProfile } = await parseBody(req);
  if (!refineBase) return err(res, 'refineBase obrigatório');

  const user = db.getUserById(payload.id);
  try { db.consumeQuota(payload.id); } catch(e) { return err(res, e.message, 402); }

  const brand = daBrand(user, brandProfile);
  const subFmtDescriptions = {
    BIG_STATEMENT: 'Single dominant phrase, centered, lots of white space, no subtitle',
    QUESTION_HOOK: 'Large question + small complement, vertical accent bar',
    CONTROVERSIAL_OPINION: 'Strong opinion statement highlighted, generates agree/disagree reaction',
    QUICK_TIP: 'Pill label + short title + divider + body text, immediately actionable',
    MINI_LIST: 'Hook title + 3 numbered items, 3-second read',
    QUOTE_AUTHORITY: 'Quote marks + elegant text + divider + author name',
    BEFORE_AFTER: 'Vertical split: left=before (muted), right=after (accent color)',
    CTA_POST: 'Strong headline + body + prominent CTA button',
    STAT_POST: 'Large number as hero + accent divider + explanation',
    BRAND_STATEMENT: 'Clean sophisticated positioning, accent lines top/bottom, brand logo area',
    LIST_CAROUSEL: 'Hook slide → 1 item per slide with numbered circles → CTA slide',
    EDUCATIONAL_CAROUSEL: 'Hook block → progressive content blocks → conclusion block',
    MISTAKE_CAROUSEL: 'Hook → mistakes (red markers) per slide → solution slide',
    STEP_BY_STEP: 'Hook → numbered steps on timeline → result slide',
    STORY_CAROUSEL: 'Emotional hook → development → climax (accent block) → conclusion',
    CONTRAST_CAROUSEL: 'Two-column comparison: left=old/bad, right=new/good (accent)',
    CHECKLIST_CAROUSEL: 'Hook → checklist items (filled=done, empty=todo) → CTA',
    MYTH_BUSTING: 'Hook → alternating MYTH (red) / TRUTH (green) pairs',
    TIPS_CAROUSEL: 'Hook → bullet tips per slide → CTA',
    TRANSFORMATION: 'Before block (muted) → arrow/divider → After block (bright/accent)',
    TWEET_CARD: 'Twitter/X card with avatar, handle, text content, engagement row',
    TWEET_THREAD: 'Twitter/X thread: connected tweet cards, narrative sequence',
  };
  const fmtLabel = { post:'Post único', carousel:'Carrossel', tweet:'Tweet Card' }[format] || (format || 'post');
  const subFmtLabel = subFormat ? (subFmtDescriptions[subFormat] || subFormat) : '';
  const netLabel = { ig:'Instagram', li:'LinkedIn', yt:'YouTube', tt:'TikTok' }[network] || (network || 'Instagram');
  const brandTone = voiceName || brand.tom || 'flexible';
  const brandColors = `background=${brand.p2||'#0D0D0F'} text=${brand.p3||'#FFFFFF'} accent=${brand.p1||'#7C3AED'}`;

  const system =
`You are a senior prompt engineer specialized in social media design systems.

Your job is to transform a structured content base into a final design blueprint.

INPUTS:
- Content base (from previous step)
- Selected FORMAT TYPE: ${fmtLabel}
- Selected SUB-FORMAT: ${subFormat || 'default'} — ${subFmtLabel}
- Selected BRAND TONE: ${brandTone}
- Brand colors: ${brandColors}
- Network: ${netLabel}
- Brand: ${brand.profissao} | ${brand.nicho}

CRITICAL:
Now you MUST adapt everything to:
1. The selected FORMAT
2. The selected BRAND TONE

RULES:
- Respect the format structure strictly
- Adapt tone into visual decisions
- Keep content short and impactful
- Optimize for readability and engagement

SUB-FORMAT BEHAVIOR (follow the selected sub-format strictly):
${subFmtLabel ? `- ${subFormat}: ${subFmtLabel}` : '- Default post: strong headline, clean layout'}
- For carousel sub-formats (LIST_CAROUSEL, EDUCATIONAL_CAROUSEL, etc.): set type="carousel", generate slides array
- For post sub-formats (BIG_STATEMENT, QUESTION_HOOK, etc.): set type="post", slides=null
- For tweet/thread: set type="post", adapt headline to Twitter card style

Output ONLY valid JSON matching this exact structure (zero extra text):
{
  "type": "post|carousel",
  "headline": "...",
  "subheadline": "...|null",
  "body_points": ["short point 1 ≤8 words", "short point 2", "short point 3"]|null,
  "data_highlight": "specific stat/number e.g. '3x' or '87%' or 'R$12k'"|null,
  "cta": "max 4-word action"|null,
  "slides": ["hook", "slide 2", "...", "CTA"]|null,
  "visual": { "background": "solid|gradient|texture", "style": "minimal|editorial|luxury|modern|bold|typographic", "image_usage": "none|subtle|dominant" },
  "layout": { "alignment": "center|left|mixed", "hierarchy": "headline-dominant|data-hero|list-flow|editorial", "spacing": "airy|balanced|compact" },
  "colors": { "background": "${brand.p2||'#0D0D0F'}", "text": "${brand.p3||'#FFFFFF'}", "accent": "${brand.p1||'#7C3AED'}" },
  "typography": { "headline_style": "bold-uppercase|mixed-weight|serif-italic|display-black|editorial", "body_style": "none|minimal|small-regular" },
  "elements": { "shapes": "none|lines|geometric|brackets", "accents": "none|minimal|arrows|numbers|rule-left" },
  "tone": "bold|emotional|minimal|luxury|authoritative|warm"
}

FIELD RULES:
- body_points: required for MINI_LIST, QUICK_TIP, CTA_POST (3 short points each ≤8 words). null for others.
- data_highlight: required for STAT_POST (the hero number). Optional for data-heavy content. null otherwise.
- cta: required for CTA_POST. Optional for others.

RULE: Output ONLY the JSON. Headline/subheadline/slides: write in SAME language as the content base. Never change the core message.`;

  try {
    const r = await callClaudeMessages({
      system,
      messages: [{ role: 'user', content: `Content base:\n\n${refineBase}\n\nGenerate the design blueprint JSON:` }],
      maxTokens: 800,
    });
    const tok = { in: r.inputTokens || 0, out: r.outputTokens || 0 };
    let blueprint = null;
    try {
      const m = r.text.match(/\{[\s\S]*\}/);
      if (m) blueprint = JSON.parse(m[0]);
    } catch { /* blueprint stays null */ }
    let refinedPrompt = '';
    if (blueprint) {
      const parts = [];
      if (blueprint.headline) parts.push(`✦ ${blueprint.headline}`);
      if (blueprint.subheadline) parts.push(blueprint.subheadline);
      if (blueprint.visual?.style) parts.push(`Estilo: ${blueprint.visual.style} · Tom: ${blueprint.tone||''}`);
      refinedPrompt = parts.join('\n');
    } else {
      refinedPrompt = r.text.trim();
    }
    res.end(JSON.stringify({ ok: true, refinedPrompt, blueprint, tok }));
  } catch(e) {
    return err(res, 'Erro ao refinar formato: ' + e.message);
  }
});

// ── Rota: Export SVG → PNG/JPG ────────────────────────────────────────────────
// Recebe o SVG, injeta as fontes em base64 e rasteriza via sharp.
// fmt: 'png' (padrão) | 'jpg'   quality: 60–100 (padrão 90, só JPG)
route('POST', '/api/user/design-agent/export', async (req, res) => {
  const payload = requireAuth(req, res); if (!payload) return;
  const { svg, fmt = 'jpg', quality = 90 } = await parseBody(req);
  if (!svg || typeof svg !== 'string' || svg.trim().length < 100)
    return err(res, 'svg inválido ou ausente');

  let sharp;
  try { sharp = require('sharp'); }
  catch { return err(res, 'Módulo sharp não disponível — execute npm install', 503); }

  try {
    const clean      = sanitizeSvg(svg);
    const withFonts  = injectFontsIntoSvg(clean);
    const svgBuf     = Buffer.from(withFonts, 'utf8');
    const q          = Math.max(60, Math.min(100, parseInt(quality) || 90));
    const isJpg      = fmt === 'jpg' || fmt === 'jpeg';

    // density 150 = ~1.5x resolution para qualidade extra sem overhead excessivo
    let pipeline = sharp(svgBuf, { density: 150 });
    if (isJpg) {
      // Fundo preto (designs têm fundo escuro; branco causaria "flash" em áreas transparentes)
      pipeline = pipeline
        .flatten({ background: { r: 5, g: 5, b: 5 } })
        .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:4:4' });
    } else {
      pipeline = pipeline.png({ compressionLevel: 6, adaptiveFiltering: true });
    }

    const output = await pipeline.toBuffer({ resolveWithObject: true });
    const mime   = isJpg ? 'image/jpeg' : 'image/png';
    const ext    = isJpg ? 'jpg' : 'png';
    const fname  = `autopostt-${Date.now()}.${ext}`;

    res.writeHead(200, {
      'Content-Type':        mime,
      'Content-Length':      output.data.length,
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control':       'no-store',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    });
    res.end(output.data);

    log.info(`[EXPORT] user=${payload.id} fmt=${ext} size=${Math.round(output.data.length / 1024)}KB`
      + ` dim=${output.info.width}x${output.info.height}`);
  } catch(e) {
    log.error('[EXPORT] Falha:', e.message);
    err(res, 'Erro ao exportar imagem: ' + e.message);
  }
});

// ─────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────

const staticFiles = [
  ['/landing', 'landing.html'],
  ['/admin',   'admin.html'],
  ['/',        ['landing.html', 'autopostt-app.html']],
  ['/app',     ['autopostt-app.html']]
];

staticFiles.forEach(([urlPath, files]) => {
  route('GET', urlPath, async (req, res) => {
    const candidates = Array.isArray(files) ? files : [files];
    for (const f of candidates) {
      const fp = path.join(__dirname, f);
      if (fs.existsSync(fp)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(fp).pipe(res);
        return;
      }
    }
    if (urlPath === '/') {
      ok(res, { status: 'AutoPostt API running', version: '13.0.0' });
    } else {
      err(res, 'Arquivo não encontrado', 404);
    }
  });
});

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// SCHEDULER — Reset mensal de quotas
// ─────────────────────────────────────────────

function scheduleMonthlyQuotaReset() {
  function msUntilFirstOfNextMonth() {
    const now  = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    return next.getTime() - now.getTime();
  }

  function doReset() {
    try {
      db.resetMonthlyQuotas();
      log.info('[QUOTA] Reset mensal executado');
    } catch (e) {
      log.error('[QUOTA] Falha no reset mensal:', e.message);
    }
    // Agenda próximo reset daqui a ~1 mês
    setTimeout(doReset, msUntilFirstOfNextMonth());
  }

  const ms = msUntilFirstOfNextMonth();
  log.info(`[QUOTA] Próximo reset mensal em ${new Date(Date.now() + ms).toISOString()}`);
  setTimeout(doReset, ms);
}

scheduleMonthlyQuotaReset();
initFontCache(); // carrega Google Fonts em background para o export funcionar

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      ...(ALLOWED_ORIGIN !== '*' ? { 'Vary': 'Origin' } : {})
    });
    return res.end();
  }

  const match = matchRoute(req.method, req.url);
  if (match) {
    try { await match.handler(req, res, match.params); }
    catch (e) { log.error('[Route Error]', req.method, req.url, e.message); err(res, 'Erro interno', 500); }
  } else {
    const body = JSON.stringify({ ok:false, error:`Rota não encontrada: ${req.method} ${req.url}` });
    res.writeHead(404, { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body), 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
    res.end(body);
  }
});

server.listen(PORT, HOST, () => {
  const hasKey = !!ANTHROPIC_KEY;
  console.log(`
╔═══════════════════════════════════════════════╗
║         AutoPostt Backend  v13.0.0            ║
╠═══════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}            ║
║  DB:        SQLite (node:sqlite built-in)     ║
║  AI Engine: ${hasKey ? '✓ Anthropic Streaming SSE  ' : '✗ ANTHROPIC_API_KEY ausente '}   ║
╠═══════════════════════════════════════════════╣
║  Novos endpoints v13:                         ║
║  POST /api/user/generate-content-stream (SSE) ║
║  GET|POST|PATCH|DELETE /api/user/calendar     ║
║  POST /api/user/onboard-step                  ║
╠═══════════════════════════════════════════════╣
║  Admin: ${ADMIN_EMAIL.padEnd(34)}║
╚═══════════════════════════════════════════════╝
${!hasKey ? '\n⚠️  Defina ANTHROPIC_API_KEY no Railway para ativar a IA.\n' : ''}`);
});
