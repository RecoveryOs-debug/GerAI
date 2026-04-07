/**
 * AutoPostt Backend — server-v13.js
 * 
 * Melhorias sobre v12:
 * 1. SQLite via node:sqlite (built-in Node 22) — zero deps, escala para 10k+ users
 * 2. SSE Streaming nos agentes de conteúdo — UX de digitação em tempo real
 * 3. API de Calendário Editorial — CRUD completo de posts agendados
 * 4. Onboarding otimizado — salva step-by-step, progresso não se perde
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
const JWT_SECRET     = process.env.JWT_SECRET || 'autopostt-dev-' + crypto.randomBytes(8).toString('hex');
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const DB_PATH        = process.env.DB_PATH || path.join(__dirname, 'autopostt.db');
const LEGACY_JSON    = process.env.LEGACY_JSON || path.join(__dirname, 'gerai.db.json');
// Em produção, defina ALLOWED_ORIGIN=https://seudominio.com no Railway
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

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

      console.log(`[MIGRATE] Legacy JSON → SQLite: ${migratedUsers} users, ${migratedGens} generations`);
    } catch (e) {
      console.error('[MIGRATE] Failed:', e.message);
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
      console.error('[SEED] ADMIN_PASSWORD não definida. Admin não criado. Defina a variável de ambiente.');
      return;
    }
    const id = this._id();
    const pw = this._hashSync(adminPw);
    this.db.prepare(`
      INSERT OR IGNORE INTO users (id,name,email,password,role,plan,quota_limit,quota_used)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, 'Pedro Admin', process.env.ADMIN_EMAIL || 'pedro@ainoz.com.br', pw, 'admin', 'elite', 99999, 0);
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
    if (u.email === 'pedro@ainoz.com.br') throw new Error('Admin master não pode ser excluído');
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
    const id = this._id();
    this.db.prepare(`
      INSERT INTO calendar_posts (id,user_id,title,content,format,network,status,scheduled_at,color,agent_slug,generation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, user_id, title || '', content || '', format || 'post', network || 'instagram',
       status || 'idea', scheduled_at || null, color || '#F5C518', agent_slug || '', generation_id || '');
    return this.getCalendarPost(id, user_id);
  }

  updateCalendarPost(id, user_id, fields) {
    const post = this.getCalendarPost(id, user_id);
    if (!post) throw new Error('Post não encontrado');
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
    const topUsers = Object.entries(userCosts)
      .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
      .slice(0, 5)
      .map(([uid, d]) => {
        const u = this.db.prepare('SELECT name,email FROM users WHERE id=?').get(uid);
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
          resolve(p.content?.[0]?.text || '');
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
    var summary = await callClaudeMessages({
      system: 'Voce e um analista de padroes de conteudo. Analise o historico e extraia insights sobre padroes, preferencias e estilo do usuario. Maximo 200 palavras. Responda em portugues.',
      messages: [{ role: 'user', content: 'Historico:\n' + lines + '\n\nExtraia: formatos preferidos, temas recorrentes, redes usadas, padroes de conteudo.' }],
      maxTokens: 300,
    });
    var currentMemory = db.getMemory(userId);
    db.upsertMemory(userId, { summary: summary.trim(), preferences: currentMemory.preferences || {}, positive: currentMemory.positive || [], negative: currentMemory.negative || [], incrementGen: false });
    console.log('[MEMORY] Summarized for user ' + userId);
  } catch(e) { console.error('[MEMORY] Summary failed:', e.message); }
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
  return { content: resultCopy, brief: brief };
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

  const modelCtx = modelN
    ? `\nMODELO SELECIONADO: ${modelN} — ${modelName}${modelTextSlots}`
    : '';

  return `Você é um especialista em marketing, copy e direção de arte para redes sociais.
Sua função é refinar o input em um prompt rico que a IA usará para gerar a imagem final.

PERFIL DO USUÁRIO:
- Profissão: ${p.profissao || 'criador de conteúdo'}
- Nicho: ${p.nicho || 'negócios'}
- Tom de voz: ${p.tom || 'autoridade'}
- Público-alvo: ${p.publico || 'profissionais'}${paletteCtx}${modelCtx}

REGRAS ABSOLUTAS:
1. O prompt refinado DEVE mencionar as cores da paleta nos contextos corretos (destaque, fundo, texto).
2. Inclua conteúdo real para cada slot de texto do modelo (se houver).
3. Preserve todos os números e dados do usuário sem alteração.
4. Expanda narrativa, emoção e contexto de negócio.
5. Retorne APENAS o prompt refinado em 3-5 frases. ZERO introduções ou explicações.
6. O resultado deve ser rico o suficiente para a IA replicar o modelo escolhido com o conteúdo e cores corretos.`;
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
// RATE LIMITER — proteção contra força bruta
// ─────────────────────────────────────────────
const _loginAttempts = new Map(); // key: email|ip → { count, firstAt }
const LOGIN_MAX      = 10;        // tentativas máximas
const LOGIN_WINDOW   = 15 * 60 * 1000; // janela de 15 minutos

function loginRateLimit(identifier) {
  const now  = Date.now();
  const entry = _loginAttempts.get(identifier) || { count: 0, firstAt: now };
  if (now - entry.firstAt > LOGIN_WINDOW) {
    // Janela expirou — resetar
    _loginAttempts.set(identifier, { count: 1, firstAt: now });
    return { blocked: false };
  }
  entry.count++;
  _loginAttempts.set(identifier, entry);
  if (entry.count > LOGIN_MAX) {
    const retryAfter = Math.ceil((LOGIN_WINDOW - (now - entry.firstAt)) / 1000);
    return { blocked: true, retryAfter };
  }
  return { blocked: false };
}

function loginRateLimitReset(identifier) {
  _loginAttempts.delete(identifier);
}

// Limpa entradas expiradas a cada 30 minutos (evita memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _loginAttempts.entries()) {
    if (now - entry.firstAt > LOGIN_WINDOW) _loginAttempts.delete(key);
  }
}, 30 * 60 * 1000);

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

  // Rate limiting por e-mail
  const rlKey = 'login:' + (email || '').toLowerCase().trim();
  const rl = loginRateLimit(rlKey);
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
  loginRateLimitReset(rlKey);
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
    const refined = await callClaudeMessages({ system: getRefineSkill(user, refineOpts) + memCtx, messages, maxTokens: 600 });
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
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
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

    db.addGeneration({ user_id: payload.id, feature: agent, format: tipo || agent, network: rede || 'instagram', concept_name: agent, prompt: input.slice(0, 200), credits_used: 1 });
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
    const { content: responseText } = await runAgentPipeline({ agent, input, user, memory, tomOverride: tom, mediaFiles });
    db.addGeneration({ user_id: payload.id, feature: agent, format: tipo || agent, network: rede || 'instagram', concept_name: agent, prompt: input.slice(0, 200), credits_used: 1 });
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

  const STYLE_DNA = {
    '01': 'fundo ultra-escuro #0A0A0A, acento dourado, linha vertical esquerda, DM Sans bold',
    '02': 'fundo branco editorial #FAFAF8, barra preta topo/rodape, Playfair serifada grande',
    '03': 'split color: metade superior cor primaria, metade inferior escura, Syne ultra-bold',
    '04': 'fundo escuro com grid de linhas, barra vertical acento esquerda, DM Sans bold',
    '05': 'fundo preto, IBM Plex Mono tamanho extremo, pseudo-codigo como elemento visual',
    '06': 'fundo creme #FAF6EE, bordas douradas finas, Playfair centrado, paleta warm',
    '07': 'fundo escuro, barras de grafico como elemento visual, Syne bold para metricas',
    '08': 'fundo preto, Bebas Neue com glow neon na cor primaria, cantos decorativos',
    '09': 'fundo branco puro, barra lateral na cor primaria, DM Sans clean e arejado',
    '10': 'fundo escuro, Cormorant Garamond italico, aspas decorativas gigantes',
    '11': 'fundo solido na cor primaria, Syne 800 em cor escura, maxima presenca',
    '12': 'fundo claro com grid de linhas como textura, barra lateral vertical',
    '13': 'fundo preto absoluto, Bebas Neue gigante, linha horizontal branca, brutalismo',
    '14': 'fundo creme #FDF8F2, circulos decorativos em acento, Cormorant italico',
    '15': 'fundo verde terminal #050F05, IBM Plex Mono com glow verde #00FF41',
    '16': 'fundo branco, barra magazine colorida topo/rodape, Syne 800 editorial',
    '17': 'fundo azul-escuro #0C0C14, circulo e triangulo geometrico, Syne com acento roxo',
    '18': 'fundo dourado solido, Bebas Neue em marrom escuro, linhas horizontais espessas',
    '19': 'fundo azul-noite #06080F, caixa glass borda translucida, acento azul eletrico',
    '20': 'fundo off-white #F8F7F4, DM Serif Display italico, linha horizontal dourada minima',
  };
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
  const gens = db.getGenerations({ limit: 1000 });
  const report = gens.map(g => {
    const u = db.getUserById(g.user_id);
    return { id:g.id, feature:g.feature||g.format||'unknown', user_name:u?.name||'?', user_email:u?.email||'',
      input_tokens:g.input_tokens||0, output_tokens:g.output_tokens||0, total_tokens:g.total_tokens||0,
      cost_usd: parseFloat((g.cost_usd||0).toFixed(6)), credits_used:g.credits_used||1, created_at:g.created_at };
  });
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
      console.log(`[QUOTA] Reset mensal executado em ${new Date().toISOString()}`);
    } catch (e) {
      console.error('[QUOTA] Falha no reset mensal:', e.message);
    }
    // Agenda próximo reset daqui a ~1 mês
    setTimeout(doReset, msUntilFirstOfNextMonth());
  }

  const ms = msUntilFirstOfNextMonth();
  console.log(`[QUOTA] Próximo reset mensal em ${new Date(Date.now() + ms).toISOString()}`);
  setTimeout(doReset, ms);
}

scheduleMonthlyQuotaReset();

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
    catch (e) { console.error('[Route Error]', req.method, req.url, e.message); err(res, 'Erro interno', 500); }
  } else {
    const body = JSON.stringify({ ok:false, error:`Rota não encontrada: ${req.method} ${req.url}` });
    res.writeHead(404, { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body), 'Access-Control-Allow-Origin':'*' });
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
║  Admin: pedro@ainoz.com.br                    ║
╚═══════════════════════════════════════════════╝
${!hasKey ? '\n⚠️  Defina ANTHROPIC_API_KEY no Railway para ativar a IA.\n' : ''}`);
});
