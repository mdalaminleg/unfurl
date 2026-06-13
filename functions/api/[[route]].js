// functions/api/[[route]].js
const JWT_SECRET = 'unfurl_super_secret_hmac_key_change_in_production';
const JWT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const DAILY_POST_LIMIT = 3;
const POST_WORD_LIMIT = 500;
const IMGBB_API_KEY = '32006c4775fab8a5ff2fae9d23b9f863';

async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signToken(payload) {
  payload.exp = Date.now() + JWT_EXPIRY_MS;
  const encoder = new TextEncoder();
  const toSign = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', encoder.encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(toSign));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${btoa(toSign)}.${sigB64}`;
}

async function verifyToken(token) {
  try {
    const [payloadB64, sigB64] = token.split('.');
    const payloadStr = atob(payloadB64);
    const payload = JSON.parse(payloadStr);
    if (payload.exp < Date.now()) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBin = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBin, new TextEncoder().encode(payloadStr));
    return valid ? payload : null;
  } catch { return null; }
}

async function getUser(request, db) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const payload = await verifyToken(token);
  if (!payload) return null;
  const user = await db.prepare('SELECT id, email, name, role, is_banned FROM users WHERE id = ?').bind(payload.id).first();
  return user;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    }
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

async function uploadToImgBB(base64Image) {
  try {
    const formData = new FormData();
    formData.append('image', base64Image);
    formData.append('key', IMGBB_API_KEY);
    const response = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: formData });
    const result = await response.json();
    if (result.success) return result.data.url;
    throw new Error(result.error?.message || 'Upload failed');
  } catch (error) {
    throw new Error('Image upload failed');
  }
}

let cachedBadWords = null;
async function loadBadWords(db) {
  if (cachedBadWords) return cachedBadWords;
  const result = await db.prepare('SELECT word FROM banned_words').all();
  cachedBadWords = result.results.map(r => r.word.toLowerCase());
  return cachedBadWords;
}
async function hasProfanity(text, db) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const words = await loadBadWords(db);
  for (const w of words) {
    if (lower.includes(w)) return true;
  }
  return false;
}
async function autoBanUser(userId, db) {
  await db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(userId).run();
  await db.prepare('DELETE FROM wishes WHERE user_id = ?').bind(userId).run();
}

function generateSlug() {
  const adjectives = ['brave', 'hopeful', 'strong', 'courageous', 'resilient', 'rising', 'unfolding', 'blooming', 'soaring', 'shining', 'gentle', 'fierce', 'wild', 'free', 'radiant'];
  const nouns = ['soul', 'heart', 'spirit', 'journey', 'path', 'light', 'dawn', 'hope', 'faith', 'dream', 'bloom', 'wing', 'root', 'seed', 'star'];
  const random = Math.random().toString(36).substring(2, 10);
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}-${random}`;
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    password_hash TEXT,
    role TEXT DEFAULT 'user',
    device_fingerprint TEXT,
    is_banned INTEGER DEFAULT 0,
    created_at INTEGER
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS wishes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    unique_slug TEXT UNIQUE,
    title TEXT,
    content TEXT,
    image_url TEXT,
    mood_weather INTEGER DEFAULT 0,
    status TEXT DEFAULT 'struggling',
    is_public INTEGER DEFAULT 0,
    love_count INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    achieved_at INTEGER,
    public_views INTEGER DEFAULT 0
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY,
    wish_id INTEGER,
    title TEXT,
    is_completed INTEGER DEFAULT 0,
    completed_at INTEGER,
    created_at INTEGER
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS loves (
    id INTEGER PRIMARY KEY,
    wish_id INTEGER,
    viewer_ip TEXT,
    created_at INTEGER,
    UNIQUE(wish_id, viewer_ip)
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS voice_encouragements (
    id INTEGER PRIMARY KEY,
    wish_id INTEGER,
    voice_url TEXT,
    created_at INTEGER
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS banned_words (
    id INTEGER PRIMARY KEY,
    word TEXT UNIQUE
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY,
    quote_text TEXT,
    author TEXT
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();

  await db.prepare('CREATE INDEX IF NOT EXISTS idx_wishes_user_id ON wishes(user_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_wishes_slug ON wishes(unique_slug)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_milestones_wish_id ON milestones(wish_id)').run();

  const badWords = ['fuck', 'shit', 'cunt', 'motherfucker', 'vagina', 'porn', 'xxx', 'hacker', 'anal', 'cock', 'dick', 'pussy', 'whore', 'slut', 'asshole', 'bitch', 'bastard', 'damn'];
  for (const w of badWords) {
    await db.prepare('INSERT OR IGNORE INTO banned_words (word) VALUES (?)').bind(w).run();
  }

  const quotes = [
    ['The only way out is through.', 'Robert Frost'],
    ['You have survived 100% of your worst days.', 'Unknown'],
    ['Stars cannot shine without darkness.', 'Unknown'],
    ['What feels like the end is often the beginning.', 'Unknown'],
    ['Your present circumstances don\'t determine where you can go.', 'Unknown']
  ];
  for (const [text, author] of quotes) {
    await db.prepare('INSERT OR IGNORE INTO quotes (quote_text, author) VALUES (?, ?)').bind(text, author).run();
  }

  const adminPass = await sha256('admin3211');
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT OR IGNORE INTO users (email, name, password_hash, role, created_at)
    VALUES ('alamin@mail.com', 'Admin', ?, 'admin', ?)`).bind(adminPass, now).run();
}

async function handleAuth(method, path, body, db) {
  if (method === 'POST' && path === '/auth/register') {
    const { email, name, password, fingerprint } = body;
    if (!email || !name || !password) return err('Missing fields');
    if (password.length < 6) return err('Password must be at least 6 characters');
    if (await hasProfanity(email, db) || await hasProfanity(password, db) || await hasProfanity(name, db)) {
      return err('Inappropriate email, name, or password', 400);
    }
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) return err('Email already exists', 400);
    const fpCheck = await db.prepare('SELECT id FROM users WHERE device_fingerprint = ?').bind(fingerprint).first();
    if (fpCheck) return err('One account per device', 403);
    const hash = await sha256(password);
    const now = Math.floor(Date.now() / 1000);
    await db.prepare('INSERT INTO users (email, name, password_hash, device_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(email, name, hash, fingerprint, now).run();
    return json({ message: 'Account created successfully. Please login.' }, 201);
  }

  if (method === 'POST' && path === '/auth/login') {
    const { email, password } = body;
    const user = await db.prepare('SELECT id, email, name, role, password_hash, is_banned FROM users WHERE email = ?').bind(email).first();
    if (!user) return err('Invalid credentials', 401);
    if (user.is_banned) return err('Account banned', 403);
    const hash = await sha256(password);
    if (hash !== user.password_hash) return err('Invalid credentials', 401);
    const token = await signToken({ id: user.id, email: user.email, role: user.role });
    return json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  }
  return null;
}

async function handleWishes(method, path, body, db, user, request) {
  if (!user || user.is_banned) return err('Unauthorized', 401);

  if (method === 'GET' && path === '/wishes') {
    const wishes = await db.prepare(`
      SELECT id, unique_slug, title, content, image_url, mood_weather, status, is_public, love_count, created_at, updated_at, achieved_at, public_views
      FROM wishes WHERE user_id = ? ORDER BY created_at DESC
    `).bind(user.id).all();
    return json({ wishes: wishes.results });
  }

  if (method === 'GET' && path.match(/^\/wishes\/(\d+)$/)) {
    const id = parseInt(path.split('/').pop());
    const wish = await db.prepare('SELECT * FROM wishes WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!wish) return err('Not found', 404);
    const milestones = await db.prepare('SELECT * FROM milestones WHERE wish_id = ? ORDER BY id').bind(id).all();
    return json({ wish, milestones: milestones.results });
  }

  if (method === 'POST' && path === '/wishes') {
    const { title, content, imageBase64, moodWeather, milestones } = body;
    if (!title || !content) return err('Title and content required');
    if (title.length > 100) return err('Title too long (max 100 chars)');
    if (content.length > POST_WORD_LIMIT) return err(`Content exceeds ${POST_WORD_LIMIT} characters`);
    if (await hasProfanity(content, db)) {
      await autoBanUser(user.id, db);
      return err('You have been banned for inappropriate content', 403);
    }
    
    if (user.role !== 'admin') {
      const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
      const count = await db.prepare('SELECT COUNT(*) as cnt FROM wishes WHERE user_id = ? AND created_at >= ?').bind(user.id, todayStart).first();
      if (count.cnt >= DAILY_POST_LIMIT) return err(`Daily limit reached (${DAILY_POST_LIMIT} wishes per day)`, 429);
    }
    
    let imageUrl = null;
    if (imageBase64) {
      try { imageUrl = await uploadToImgBB(imageBase64); } catch(e) { return err('Image upload failed', 400); }
    }
    
    const now = Math.floor(Date.now() / 1000);
    const slug = generateSlug();
    const result = await db.prepare(`
      INSERT INTO wishes (user_id, unique_slug, title, content, image_url, mood_weather, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'struggling', ?, ?)
    `).bind(user.id, slug, title, content, imageUrl, moodWeather || 0, now, now).run();
    
    const wishId = result.meta.last_row_id;
    
    if (milestones && milestones.length) {
      for (let i = 0; i < Math.min(milestones.length, 3); i++) {
        if (milestones[i].trim()) {
          await db.prepare('INSERT INTO milestones (wish_id, title, created_at) VALUES (?, ?, ?)')
            .bind(wishId, milestones[i], now).run();
        }
      }
    }
    
    return json({ success: true, id: wishId, slug });
  }

  if (method === 'PUT' && path.match(/^\/wishes\/(\d+)$/)) {
    const id = parseInt(path.split('/').pop());
    const { title, content, status, milestones } = body;
    const wish = await db.prepare('SELECT * FROM wishes WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!wish) return err('Not found', 404);
    
    if (content && await hasProfanity(content, db)) {
      await autoBanUser(user.id, db);
      return err('Banned for inappropriate content', 403);
    }
    
    const now = Math.floor(Date.now() / 1000);
    let achievedAt = wish.achieved_at;
    if (status === 'achieved' && wish.status !== 'achieved') {
      achievedAt = now;
    }
    
    await db.prepare(`
      UPDATE wishes SET title = COALESCE(?, title), content = COALESCE(?, content), status = COALESCE(?, status),
      updated_at = ?, achieved_at = COALESCE(?, achieved_at)
      WHERE id = ?
    `).bind(title, content, status, now, achievedAt, id).run();
    
    if (milestones && milestones.length) {
      for (const m of milestones) {
        if (m.id) {
          await db.prepare('UPDATE milestones SET is_completed = ? WHERE id = ? AND wish_id = ?')
            .bind(m.is_completed ? 1 : 0, m.id, id).run();
        }
      }
    }
    
    return json({ success: true });
  }

  if (method === 'POST' && path.match(/^\/wishes\/(\d+)\/milestone\/(\d+)$/)) {
    const wishId = parseInt(path.split('/')[2]);
    const milestoneId = parseInt(path.split('/')[4]);
    const { is_completed } = body;
    const wish = await db.prepare('SELECT id FROM wishes WHERE id = ? AND user_id = ?').bind(wishId, user.id).first();
    if (!wish) return err('Not found', 404);
    const now = Math.floor(Date.now() / 1000);
    await db.prepare('UPDATE milestones SET is_completed = ?, completed_at = ? WHERE id = ? AND wish_id = ?')
      .bind(is_completed ? 1 : 0, is_completed ? now : null, milestoneId, wishId).run();
    return json({ success: true });
  }

  if (method === 'DELETE' && path.match(/^\/wishes\/(\d+)$/)) {
    const id = parseInt(path.split('/').pop());
    await db.prepare('DELETE FROM wishes WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    await db.prepare('DELETE FROM milestones WHERE wish_id = ?').bind(id).run();
    return json({ success: true });
  }

  if (method === 'POST' && path.match(/^\/wishes\/(\d+)\/share$/)) {
    const id = parseInt(path.split('/')[2]);
    const wish = await db.prepare('SELECT * FROM wishes WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!wish) return err('Not found', 404);
    if (wish.status !== 'achieved') return err('Can only share wishes marked as achieved', 400);
    
    await db.prepare('UPDATE wishes SET is_public = 1 WHERE id = ?').bind(id).run();
    const baseUrl = request.headers.get('origin') || 'https://unfurl.app';
    return json({ success: true, url: `${baseUrl}/public/${wish.unique_slug}` });
  }

  if (method === 'GET' && path === '/quote') {
    const quotes = await db.prepare('SELECT quote_text, author FROM quotes').all();
    const randomQuote = quotes.results[Math.floor(Math.random() * quotes.results.length)];
    return json({ quote: randomQuote });
  }

  if (method === 'GET' && path === '/remaining-posts') {
    const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    const count = await db.prepare('SELECT COUNT(*) as cnt FROM wishes WHERE user_id = ? AND created_at >= ?').bind(user.id, todayStart).first();
    const remaining = Math.max(0, DAILY_POST_LIMIT - (count?.cnt || 0));
    const nextReset = new Date();
    nextReset.setHours(24, 0, 0, 0);
    const resetSeconds = Math.floor((nextReset.getTime() - Date.now()) / 1000);
    return json({ remaining, resetSeconds });
  }

  return null;
}

async function handlePublic(method, path, body, db, request) {
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  
  if (method === 'GET' && path.match(/^\/public\/([a-z-]+)$/)) {
    const slug = path.split('/').pop();
    const wish = await db.prepare(`
      SELECT w.*, u.name as user_name 
      FROM wishes w 
      JOIN users u ON w.user_id = u.id 
      WHERE w.unique_slug = ? AND w.is_public = 1 AND w.status = 'achieved'
    `).bind(slug).first();
    if (!wish) return err('Not found or not yet shared', 404);
    
    await db.prepare('UPDATE wishes SET public_views = public_views + 1 WHERE id = ?').bind(wish.id).run();
    
    const milestones = await db.prepare('SELECT * FROM milestones WHERE wish_id = ? ORDER BY id').bind(wish.id).all();
    const loveCount = await db.prepare('SELECT COUNT(*) as count FROM loves WHERE wish_id = ?').bind(wish.id).first();
    const hasLoved = await db.prepare('SELECT id FROM loves WHERE wish_id = ? AND viewer_ip = ?').bind(wish.id, clientIp).first();
    const voiceMessages = await db.prepare('SELECT voice_url, created_at FROM voice_encouragements WHERE wish_id = ? ORDER BY created_at DESC').bind(wish.id).all();
    
    return json({
      wish: {
        id: wish.id,
        title: wish.title,
        content: wish.content,
        image_url: wish.image_url,
        mood_weather: wish.mood_weather,
        status: wish.status,
        love_count: loveCount?.count || 0,
        has_loved: !!hasLoved,
        created_at: wish.created_at,
        achieved_at: wish.achieved_at,
        user_name: wish.user_name,
        public_views: wish.public_views + 1
      },
      milestones: milestones.results,
      voice_messages: voiceMessages.results
    });
  }

  if (method === 'POST' && path.match(/^\/public\/([a-z-]+)\/love$/)) {
    const slug = path.split('/')[2];
    const wish = await db.prepare('SELECT id FROM wishes WHERE unique_slug = ? AND is_public = 1').bind(slug).first();
    if (!wish) return err('Wish not found', 404);
    
    const existing = await db.prepare('SELECT id FROM loves WHERE wish_id = ? AND viewer_ip = ?').bind(wish.id, clientIp).first();
    if (existing) {
      await db.prepare('DELETE FROM loves WHERE wish_id = ? AND viewer_ip = ?').bind(wish.id, clientIp).run();
      await db.prepare('UPDATE wishes SET love_count = love_count - 1 WHERE id = ?').bind(wish.id).run();
      const newCount = await db.prepare('SELECT love_count FROM wishes WHERE id = ?').bind(wish.id).first();
      return json({ loved: false, love_count: newCount.love_count });
    } else {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare('INSERT INTO loves (wish_id, viewer_ip, created_at) VALUES (?, ?, ?)').bind(wish.id, clientIp, now).run();
      await db.prepare('UPDATE wishes SET love_count = love_count + 1 WHERE id = ?').bind(wish.id).run();
      const newCount = await db.prepare('SELECT love_count FROM wishes WHERE id = ?').bind(wish.id).first();
      return json({ loved: true, love_count: newCount.love_count });
    }
  }

  if (method === 'POST' && path.match(/^\/public\/([a-z-]+)\/voice$/)) {
    const slug = path.split('/')[2];
    const { voiceBase64 } = body;
    if (!voiceBase64) return err('No voice recording provided');
    
    const wish = await db.prepare('SELECT id FROM wishes WHERE unique_slug = ? AND is_public = 1').bind(slug).first();
    if (!wish) return err('Wish not found', 404);
    
    let voiceUrl = null;
    try { voiceUrl = await uploadToImgBB(voiceBase64); } catch(e) { return err('Voice upload failed', 400); }
    
    const now = Math.floor(Date.now() / 1000);
    await db.prepare('INSERT INTO voice_encouragements (wish_id, voice_url, created_at) VALUES (?, ?, ?)')
      .bind(wish.id, voiceUrl, now).run();
    return json({ success: true });
  }

  return null;
}

async function handleAdmin(method, path, body, db, user) {
  if (!user || user.role !== 'admin') return err('Forbidden', 403);

  if (method === 'GET' && path === '/admin/users') {
    const users = await db.prepare('SELECT id, email, name, role, is_banned, created_at FROM users ORDER BY created_at DESC').all();
    return json({ users: users.results });
  }

  if (method === 'POST' && path === '/admin/user/ban') {
    const { userId } = body;
    await db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(userId).run();
    await db.prepare('DELETE FROM wishes WHERE user_id = ?').bind(userId).run();
    return json({ success: true });
  }

  if (method === 'POST' && path === '/admin/user/unban') {
    const { userId } = body;
    await db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').bind(userId).run();
    return json({ success: true });
  }

  if (method === 'DELETE' && path.match(/^\/admin\/wish\/(\d+)$/)) {
    const wishId = parseInt(path.split('/').pop());
    await db.prepare('DELETE FROM wishes WHERE id = ?').bind(wishId).run();
    return json({ success: true });
  }

  if (method === 'GET' && path === '/admin/wishes') {
    const wishes = await db.prepare(`
      SELECT w.*, u.name as user_name, u.email as user_email 
      FROM wishes w JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 100
    `).all();
    return json({ wishes: wishes.results });
  }

  if (method === 'GET' && path === '/admin/stats') {
    const userCount = await db.prepare('SELECT COUNT(*) as count FROM users').first();
    const wishCount = await db.prepare('SELECT COUNT(*) as count FROM wishes').first();
    const publicCount = await db.prepare('SELECT COUNT(*) as count FROM wishes WHERE is_public = 1').first();
    const achievedCount = await db.prepare('SELECT COUNT(*) as count FROM wishes WHERE status = "achieved"').first();
    const bannedCount = await db.prepare('SELECT COUNT(*) as count FROM users WHERE is_banned = 1').first();
    const totalLoves = await db.prepare('SELECT COUNT(*) as count FROM loves').first();
    const voiceCount = await db.prepare('SELECT COUNT(*) as count FROM voice_encouragements').first();
    return json({
      users: userCount?.count || 0,
      wishes: wishCount?.count || 0,
      publicWishes: publicCount?.count || 0,
      achievedWishes: achievedCount?.count || 0,
      bannedUsers: bannedCount?.count || 0,
      totalLoves: totalLoves?.count || 0,
      voiceMessages: voiceCount?.count || 0
    });
  }

  if (method === 'GET' && path === '/admin/banned-words') {
    const words = await db.prepare('SELECT word FROM banned_words ORDER BY word').all();
    return json({ words: words.results });
  }
  if (method === 'POST' && path === '/admin/banned-words') {
    const { word } = body;
    await db.prepare('INSERT OR IGNORE INTO banned_words (word) VALUES (?)').bind(word.toLowerCase()).run();
    cachedBadWords = null;
    return json({ success: true });
  }
  if (method === 'DELETE' && path === '/admin/banned-words') {
    const { word } = body;
    await db.prepare('DELETE FROM banned_words WHERE word = ?').bind(word.toLowerCase()).run();
    cachedBadWords = null;
    return json({ success: true });
  }

  return err('Not found', 404);
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.UNFURL_DB;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization'
      }
    });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;
  let body = {};
  if (method !== 'GET' && method !== 'DELETE') {
    try { body = await request.json(); } catch(e) {}
  }

  if (!globalThis.__tablesReady) {
    await ensureTables(db);
    globalThis.__tablesReady = true;
  }

  if (path.startsWith('/auth/')) {
    const res = await handleAuth(method, path, body, db);
    if (res) return res;
  }

  if (path.startsWith('/public/')) {
    const res = await handlePublic(method, path, body, db, request);
    if (res) return res;
  }

  const user = await getUser(request, db);
  if (!user) return err('Unauthorized', 401);

  const wishRes = await handleWishes(method, path, body, db, user, request);
  if (wishRes) return wishRes;

  const adminRes = await handleAdmin(method, path, body, db, user);
  if (adminRes) return adminRes;

  return err('Not found', 404);
}
