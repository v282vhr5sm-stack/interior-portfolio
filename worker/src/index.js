// 포트폴리오 서버 (Cloudflare Worker + D1 데이터베이스 + R2 사진 저장소)
//  GET  /p/<key>              사진 보기 (누구나)
//  GET  /data                 현장·사진 목록 (고객은 숨긴 현장 제외)
//  GET  /version              마지막 변경 시각 (자동 새로고침용)
//  POST /login {password}     관리자 로그인 → 토큰
//  이하 관리자 토큰 필요:
//  PUT  /p/<key>              사진 올리기
//  POST /delete {keys}        사진 파일 지우기
//  GET  /usage                저장공간 사용량
//  POST /sites, PATCH|DELETE /sites/<id>
//  POST /photos, PATCH|DELETE /photos/<id>
const MAX_BYTES = 8 * 1024 * 1024;
const TOKEN_DAYS = 180;
const SITE_FIELDS = ['name', 'info', 'hidden', 'cover', 'sort'];
const PHOTO_FIELDS = ['site_id', 'phase', 'space'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // ---------- 공개 ----------
      if (req.method === 'GET' && path.startsWith('/p/')) {
        const obj = await env.BUCKET.get(decodeURIComponent(path.slice(3)));
        if (!obj) return new Response('not found', { status: 404, headers: cors });
        return new Response(obj.body, { headers: { ...cors, 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: obj.httpEtag } });
      }
      const admin = await isAdmin(req, env);

      if (req.method === 'GET' && path === '/version') return json({ v: await getVersion(env) });

      if (req.method === 'GET' && path === '/data') {
        const sites = (await env.DB.prepare(`SELECT * FROM sites ${admin ? '' : 'WHERE hidden = 0'} ORDER BY sort DESC`).all()).results.map(siteOut);
        const ok = new Set(sites.map(s => s.id));
        const photos = (await env.DB.prepare('SELECT * FROM photos ORDER BY created_at').all()).results
          .filter(p => admin || p.site_id === null || ok.has(p.site_id))
          .map(p => admin ? p : { ...p, src_name: undefined, src_size: undefined });
        return json({ sites, photos, v: await getVersion(env), admin });
      }

      if (req.method === 'POST' && path === '/login') {
        const { password = '' } = await req.json().catch(() => ({}));
        if (!env.ADMIN_PASSWORD || !(await safeEqual(password, env.ADMIN_PASSWORD))) {
          await new Promise(r => setTimeout(r, 1000));
          return json({ error: '비밀번호가 맞지 않아요' }, 401);
        }
        return json({ token: await makeToken(env) });
      }

      // ---------- 관리자 ----------
      if (!admin) return json({ error: '로그인이 필요해요' }, 401);

      if (req.method === 'PUT' && path.startsWith('/p/')) {
        const key = decodeURIComponent(path.slice(3));
        if (!/^ph\/[\w-]+\.jpg$/.test(key)) return json({ error: '잘못된 경로' }, 403);
        if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: '파일이 너무 커요' }, 413);
        await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: 'image/jpeg' } });
        return json({ ok: true, key });
      }
      if (req.method === 'POST' && path === '/delete') {
        const { keys = [] } = await req.json().catch(() => ({}));
        await deleteFiles(env, keys);
        return json({ ok: true });
      }
      if (req.method === 'GET' && path === '/usage') {
        let bytes = 0, count = 0, cursor;
        do {
          const r = await env.BUCKET.list({ cursor, limit: 1000 });
          for (const o of r.objects) { bytes += o.size; count++; }
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
        return json({ bytes, count, limit: +env.LIMIT_BYTES });
      }

      const m = path.match(/^\/(sites|photos)(?:\/([\w-]+))?$/);
      if (m) {
        const [, table, id] = m;
        if (req.method === 'POST' && !id) {
          const b = await req.json();
          const now = new Date().toISOString();
          if (table === 'sites') {
            const row = { id: b.id || crypto.randomUUID(), name: String(b.name || '').trim(), info: JSON.stringify(b.info || {}), hidden: b.hidden ? 1 : 0, cover: b.cover || null, sort: b.sort || Date.now() / 1000, created_at: now };
            if (!row.name) return json({ error: '현장 이름이 없어요' }, 400);
            await insert(env, 'sites', row);
            await touch(env);
            return json(siteOut(row));
          }
          const row = { id: b.id || crypto.randomUUID(), site_id: b.site_id || null, phase: ['before', 'during', 'after'].includes(b.phase) ? b.phase : 'after', space: String(b.space || '기타'), t: b.t, l: b.l, w: b.w | 0, h: b.h | 0, src_name: b.src_name || null, src_size: b.src_size || null, created_at: now };
          if (!/^ph\//.test(row.t) || !/^ph\//.test(row.l)) return json({ error: '잘못된 경로' }, 400);
          await insert(env, 'photos', row);
          await touch(env);
          return json(row);
        }
        if (req.method === 'PATCH' && id) {
          const b = await req.json();
          const fields = (table === 'sites' ? SITE_FIELDS : PHOTO_FIELDS).filter(f => f in b);
          if (!fields.length) return json({ ok: true });
          const vals = fields.map(f => f === 'info' ? JSON.stringify(b[f] || {}) : f === 'hidden' ? (b[f] ? 1 : 0) : b[f] ?? null);
          await env.DB.prepare(`UPDATE ${table} SET ${fields.map(f => f + ' = ?').join(', ')} WHERE id = ?`).bind(...vals, id).run();
          await touch(env);
          return json({ ok: true });
        }
        if (req.method === 'DELETE' && id) {
          const where = table === 'sites' ? 'site_id = ?' : 'id = ?';
          const ps = (await env.DB.prepare(`SELECT t, l FROM photos WHERE ${where}`).bind(id).all()).results;
          await deleteFiles(env, ps.flatMap(p => [p.t, p.l]));
          await env.DB.prepare(`DELETE FROM photos WHERE ${where}`).bind(id).run();
          if (table === 'sites') await env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id).run();
          await touch(env);
          return json({ ok: true });
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};

const siteOut = s => ({ ...s, info: typeof s.info === 'string' ? JSON.parse(s.info || '{}') : s.info, hidden: !!s.hidden });
async function insert(env, table, row) {
  const keys = Object.keys(row);
  await env.DB.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...keys.map(k => row[k])).run();
}
async function deleteFiles(env, keys) {
  const ok = keys.filter(k => typeof k === 'string' && /^ph\//.test(k));
  for (let i = 0; i < ok.length; i += 1000) await env.BUCKET.delete(ok.slice(i, i + 1000));
}
async function getVersion(env) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'version'").first();
  return r ? r.v : '0';
}
async function touch(env) {
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(Date.now())).run();
}

// ---------- 로그인 토큰 (HMAC 서명) ----------
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TOKEN_KEY + '|' + env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function makeToken(env) {
  const exp = String(Date.now() + TOKEN_DAYS * 86400000);
  return exp + '.' + await hmac(env, exp);
}
async function isAdmin(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !env.TOKEN_KEY || !env.ADMIN_PASSWORD) return false;
  const [exp, sig] = auth.slice(7).split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEqual(sig, await hmac(env, exp));
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
