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
const MAX_BYTES = 15 * 1024 * 1024; // 메인파일 4000px 대비
const MAX_VIDEO = 95 * 1024 * 1024; // 무료 요금제는 요청 하나에 100MB까지
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
      // 등록된 사이트 주소 + 내 컴퓨터 테스트 주소(localhost 아무 포트)
      'Access-Control-Allow-Origin': allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // ---------- 공개 ----------
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/p/')) {
        const key = decodeURIComponent(path.slice(3));
        // 동영상은 구간 요청(Range)을 받아야 아이폰에서 재생·건너뛰기가 됨
        const rm = (req.headers.get('Range') || '').match(/^bytes=(\d*)-(\d*)$/);
        const head = await env.BUCKET.head(key);
        if (!head) return new Response('not found', { status: 404, headers: cors });
        const size = head.size;
        const base = { ...cors, 'Content-Type': head.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: head.httpEtag, 'Accept-Ranges': 'bytes', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };
        if (rm && (rm[1] || rm[2])) {
          let start = rm[1] ? +rm[1] : Math.max(0, size - +rm[2]);
          let end = rm[1] && rm[2] ? Math.min(+rm[2], size - 1) : size - 1;
          if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
          const obj = req.method === 'HEAD' ? null : await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
          return new Response(obj && obj.body, { status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
        }
        const obj = req.method === 'HEAD' ? null : await env.BUCKET.get(key);
        return new Response(obj && obj.body, { headers: { ...base, 'Content-Length': String(size) } });
      }
      const admin = await isAdmin(req, env);

      if (req.method === 'GET' && path === '/version') return json({ v: await getVersion(env) });

      if (req.method === 'GET' && path === '/data') {
        let sites = (await env.DB.prepare(`SELECT * FROM sites ${admin ? '' : 'WHERE hidden = 0'} ORDER BY sort DESC`).all()).results.map(siteOut);
        const ok = new Set(sites.map(s => s.id));
        let photos = (await env.DB.prepare('SELECT * FROM photos ORDER BY created_at').all()).results
          // 고객: 메인파일(+원본 PDF) + 공간별로 분류된 공사후 사진 (공사전·공사중·미분류는 안 보냄)
          .filter(p => admin || (ok.has(p.site_id) && (p.type === 'main' || p.type === 'mainpdf' || (p.phase === 'after' && p.space !== '미분류'))))
          .sort((a, b) => (a.type === 'main' && b.type === 'main' ? a.ord - b.ord : 0))
          .map(p => admin ? p : { ...p, src_name: undefined, src_size: undefined });
        if (!admin) { // 고객 목록: 메인파일이나 분류된 사진이 있는 현장
          const has = new Set(photos.filter(p => p.type !== 'mainpdf').map(p => p.site_id));
          sites = sites.filter(s => has.has(s.id));
        }
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

      // 쓰고 있는 동안엔 로그인 연장 (새 토큰 발급)
      if (req.method === 'POST' && path === '/refresh') return json({ token: await makeToken(env) });

      if (req.method === 'PUT' && path.startsWith('/p/')) {
        const key = decodeURIComponent(path.slice(3));
        // 동영상 (mp4/mov): 메모리를 안 쓰게 그대로 흘려서 저장 → 저장 후 파일 앞부분 확인
        if (/^ph\/[\w-]+_v\.mp4$/.test(key)) {
          const len = +req.headers.get('Content-Length') || 0;
          if (!len) return json({ error: '파일 크기를 알 수 없어요' }, 411);
          if (len > MAX_VIDEO) return json({ error: `동영상이 너무 커요 (최대 ${Math.round(MAX_VIDEO / 1048576)}MB)` }, 413);
          await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: 'video/mp4' } });
          const top = await env.BUCKET.get(key, { range: { offset: 0, length: 12 } });
          const b = new Uint8Array(await top.arrayBuffer());
          const box = String.fromCharCode(...b.slice(4, 8));
          if (!['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) { await env.BUCKET.delete(key); return json({ error: 'MP4 동영상만 올릴 수 있어요' }, 415); }
          return json({ ok: true, key });
        }
        // 메인파일 원본 PDF (고객 다운로드용): 그대로 흘려서 저장 → 앞부분이 %PDF 인지 확인
        if (/^ph\/[\w-]+_doc\.pdf$/.test(key)) {
          const len = +req.headers.get('Content-Length') || 0;
          if (!len) return json({ error: '파일 크기를 알 수 없어요' }, 411);
          if (len > MAX_VIDEO) return json({ error: `PDF가 너무 커요 (최대 ${Math.round(MAX_VIDEO / 1048576)}MB)` }, 413);
          await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: 'application/pdf' } });
          const top = new Uint8Array(await (await env.BUCKET.get(key, { range: { offset: 0, length: 4 } })).arrayBuffer());
          if (String.fromCharCode(...top) !== '%PDF') { await env.BUCKET.delete(key); return json({ error: 'PDF 파일이 아니에요' }, 415); }
          return json({ ok: true, key });
        }
        if (!/^ph\/[\w-]+\.jpg$/.test(key)) return json({ error: '잘못된 경로' }, 403);
        if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: '파일이 너무 커요' }, 413);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_BYTES) return json({ error: '파일이 너무 커요' }, 413);
        const h = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
        if (h[0] !== 0xFF || h[1] !== 0xD8 || h[2] !== 0xFF) return json({ error: 'JPEG 사진만 올릴 수 있어요' }, 415);
        await env.BUCKET.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
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

      // 여러 장 한꺼번에: 분류 바꾸기 / 삭제
      if (req.method === 'POST' && (path === '/photos/batch' || path === '/photos/batch-delete')) {
        const b = await req.json();
        const ids = (Array.isArray(b.ids) ? b.ids : []).filter(x => typeof x === 'string').slice(0, 2000);
        if (!ids.length) return json({ ok: true, n: 0 });
        const chunks = []; for (let i = 0; i < ids.length; i += 90) chunks.push(ids.slice(i, i + 90));
        if (path === '/photos/batch-delete') {
          for (const c of chunks) {
            const q = c.map(() => '?').join(',');
            const ps = (await env.DB.prepare(`SELECT t, l FROM photos WHERE id IN (${q})`).bind(...c).all()).results;
            await deleteFiles(env, ps.flatMap(p => [p.t, p.l]));
            await env.DB.prepare(`DELETE FROM photos WHERE id IN (${q})`).bind(...c).run();
          }
        } else {
          const patch = b.patch || {};
          const fields = PHOTO_FIELDS.filter(f => f in patch);
          if (!fields.length) return json({ ok: true, n: 0 });
          if ('phase' in patch && !['before', 'during', 'after'].includes(patch.phase)) return json({ error: '단계가 잘못됐어요' }, 400);
          const vals = fields.map(f => patch[f] ?? null);
          await env.DB.batch(chunks.map(c => env.DB.prepare(`UPDATE photos SET ${fields.map(f => f + ' = ?').join(', ')} WHERE id IN (${c.map(() => '?').join(',')})`).bind(...vals, ...c)));
        }
        await touch(env);
        return json({ ok: true, n: ids.length });
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
          const row = { id: b.id || crypto.randomUUID(), site_id: b.site_id || null, phase: ['before', 'during', 'after'].includes(b.phase) ? b.phase : 'after', space: String(b.space || '기타'), t: b.t, l: b.l, w: b.w | 0, h: b.h | 0, src_name: b.src_name || null, src_size: b.src_size || null, type: ['video', 'main', 'mainpdf'].includes(b.type) ? b.type : 'image', ord: b.ord | 0, created_at: now };
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
