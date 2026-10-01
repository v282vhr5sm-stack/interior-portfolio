// 포트폴리오 사진 저장소 (Cloudflare Worker + R2)
//  GET    /p/<uid>/<file>.jpg    누구나 사진 보기
//  PUT    /p/<uid>/<file>.jpg    로그인한 본인만 올리기 (Supabase 로그인 토큰 확인)
//  POST   /delete  {keys:[...]}  본인 사진 지우기
//  GET    /usage                 사용량 (로그인 필요)
const MAX_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // 사진 보기
    if (req.method === 'GET' && url.pathname.startsWith('/p/')) {
      const key = decodeURIComponent(url.pathname.slice(3));
      const obj = await env.BUCKET.get(key);
      if (!obj) return new Response('not found', { status: 404, headers: cors });
      return new Response(obj.body, {
        headers: {
          ...cors,
          'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: obj.httpEtag,
        },
      });
    }

    // 이하 로그인 필요
    const uid = await userId(req, env);
    if (!uid) return json({ error: '로그인이 필요해요' }, 401);

    if (req.method === 'PUT' && url.pathname.startsWith('/p/')) {
      const key = decodeURIComponent(url.pathname.slice(3));
      if (!key.startsWith(uid + '/') || !/^[\w-]+\/[\w-]+\.jpg$/.test(key)) return json({ error: '잘못된 경로' }, 403);
      const len = +req.headers.get('Content-Length') || 0;
      if (len > MAX_BYTES) return json({ error: '파일이 너무 커요' }, 413);
      await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: 'image/jpeg' } });
      return json({ ok: true, key });
    }

    if (req.method === 'POST' && url.pathname === '/delete') {
      const { keys = [] } = await req.json().catch(() => ({}));
      const mine = keys.filter(k => typeof k === 'string' && k.startsWith(uid + '/'));
      for (let i = 0; i < mine.length; i += 1000) await env.BUCKET.delete(mine.slice(i, i + 1000));
      return json({ ok: true, deleted: mine.length });
    }

    if (req.method === 'GET' && url.pathname === '/usage') {
      let bytes = 0, count = 0, cursor;
      do {
        const r = await env.BUCKET.list({ cursor, limit: 1000 });
        for (const o of r.objects) { bytes += o.size; count++; }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      return json({ bytes, count, limit: +env.LIMIT_BYTES });
    }

    return json({ error: 'not found' }, 404);
  },
};

// Supabase 로그인 토큰이 진짜인지 Supabase에 물어봄
async function userId(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { Authorization: auth, apikey: env.SUPABASE_KEY } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id;
}
