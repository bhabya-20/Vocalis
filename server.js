require('dotenv').config();
const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const pool = new Pool(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined
} : {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vocalis',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});
const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'vocalis_session';
const SESSION_DAYS = 7;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const authAttempts = new Map();

const columns = 'id, title, content, language, created_at AS "createdAt", updated_at AS "updatedAt"';
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const entry = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  return entry ? entry.slice(name.length + 1) : null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + (SESSION_DAYS * 86400) + secure);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' + secure);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$8$1$' + salt.toString('hex') + '$' + key.toString('hex');
}

async function verifyPassword(password, stored) {
  const [kind, n, r, p, saltHex, keyHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function authRateLimit(req, res, next) {
  if (req.method !== 'POST' || !['/signup', '/signin'].includes(req.path)) return next();
  const now = Date.now();
  const key = req.ip || 'local';
  const current = authAttempts.get(key);
  if (!current || now - current.startedAt >= AUTH_WINDOW_MS) {
    authAttempts.set(key, { startedAt: now, count: 1 });
    return next();
  }
  if (current.count >= AUTH_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
  current.count++;
  next();
}

app.use('/api/auth', authRateLimit);

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL \'7 days\')',
    [tokenHash(token), userId]
  );
  setSessionCookie(res, token);
}

async function requireAuth(req, res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: 'Sign in to access your transcriptions.' });
  try {
    const { rows } = await pool.query(
      'SELECT users.id, users.email FROM user_sessions JOIN users ON users.id = user_sessions.user_id WHERE user_sessions.token_hash = $1 AND user_sessions.expires_at > CURRENT_TIMESTAMP',
      [tokenHash(token)]
    );
    if (!rows.length) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
    }
    req.user = rows[0];
    next();
  } catch (error) { next(error); }
}

app.post('/api/auth/signup', async (req, res, next) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Use a password between 8 and 128 characters.' });
  try {
    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email', [email, passwordHash]);
    await createSession(rows[0].id, res);
    res.status(201).json({ user: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
    next(error);
  }
});

app.post('/api/auth/signin', async (req, res, next) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Enter your email and a password between 8 and 128 characters.' });
  try {
    const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    if (!rows.length || !(await verifyPassword(password, rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    await createSession(rows[0].id, res);
    res.json({ user: { id: rows[0].id, email: rows[0].email } });
  } catch (error) { next(error); }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.post('/api/auth/logout', async (req, res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  try {
    if (token && /^[a-f0-9]{64}$/.test(token)) await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash(token)]);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use('/api/transcriptions', requireAuth);

function validTranscription(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object';
  if (typeof body.title !== 'string' || !body.title.trim()) return 'Title is required';
  if (body.title.trim().length > 200) return 'Title must be 200 characters or fewer';
  if (typeof body.content !== 'string' || !body.content.trim()) return 'Content is required';
  if (body.content.trim().length > 100000) return 'Content must be 100,000 characters or fewer';
  if (typeof body.language !== 'string' || !body.language.trim()) return 'Language is required';
  if (body.language.trim().length > 32) return 'Language must be 32 characters or fewer';
  return null;
}

function parseId(value) {
  return /^\d+$/.test(value) && Number(value) > 0 ? value : null;
}

app.get('/api/transcriptions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${columns} FROM transcriptions WHERE user_id = $1 ORDER BY updated_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/transcriptions', async (req, res, next) => {
  const problem = validTranscription(req.body);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const { rows } = await pool.query(
      `INSERT INTO transcriptions (user_id, title, content, language) VALUES ($1, $2, $3, $4) RETURNING ${columns}`,
      [req.user.id, req.body.title.trim(), req.body.content.trim(), req.body.language.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/transcriptions/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid transcription id' });
  try {
    const { rows } = await pool.query(`SELECT ${columns} FROM transcriptions WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Transcription not found' });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.put('/api/transcriptions/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid transcription id' });
  const problem = validTranscription(req.body);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const { rows } = await pool.query(
      `UPDATE transcriptions SET title = $1, content = $2, language = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND user_id = $5 RETURNING ${columns}`,
      [req.body.title.trim(), req.body.content.trim(), req.body.language.trim(), id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transcription not found' });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.delete('/api/transcriptions/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid transcription id' });
  try {
    const result = await pool.query('DELETE FROM transcriptions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Transcription not found' });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must be valid JSON' });
  res.status(500).json({ error: 'Server error. Check the database connection and try again.' });
});

async function initializeDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS transcriptions (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    language VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query('ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transcriptions_updated_at ON transcriptions (updated_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transcriptions_user_updated ON transcriptions (user_id, updated_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions (expires_at)');
  await pool.query('DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
}

async function start() {
  await initializeDatabase();
  app.listen(PORT, '0.0.0.0', () => console.log(`Vocalis is running at http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error('Could not start Vocalis. Check the PostgreSQL settings in .env.', error.message);
    process.exit(1);
  });
}

module.exports = { app, initializeDatabase };

if (require.main === module) {
  process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
  process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
}
