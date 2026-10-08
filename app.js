(() => {
  const CFG = window.SITE_CONFIG;
  const ADMIN = !!window.PF_ADMIN;
  const PH_NAME = { before: '공사전', during: '공사중', after: '공사후' };
  const PH_ORDER = ['before', 'during', 'after'];
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const imgUrl = p => `${CFG.API_URL}/p/${p}`;
  const clean = n => String(n).replace(/^\d+\s*[._\-)]\s*/, '').trim() || String(n);
  const spaceOf = n => { const c = clean(n); return CFG.spaceAlias[c] || c; };

  // ---------- 서버 (Cloudflare Worker) ----------
  const TOKEN = 'pf-admin-token';
  const getToken = () => { try { return ADMIN ? localStorage.getItem(TOKEN) : null; } catch { return null; } };
  async function api(method, path, body) {
    const headers = {};
    const tk = getToken(); if (tk) headers.Authorization = 'Bearer ' + tk;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(CFG.API_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && ADMIN && path !== '/login') { try { localStorage.removeItem(TOKEN); } catch {} session = null; render(); }
    if (!r.ok) throw new Error(data.error || '서버 오류 ' + r.status);
    return data;
  }
  // 예전 코드 모양(sb.from(...).update(...).eq(...))을 그대로 쓰기 위한 얇은 연결부
  const sb = { from(table) {
    const base = table === 'pf_sites' ? '/sites' : '/photos';
    const run = (method, path, body) => api(method, path, body).then(data => ({ data, error: null }), error => ({ data: null, error }));
    return {
      update: patch => ({ eq: (_k, id) => run('PATCH', `${base}/${id}`, patch) }),
      delete: () => ({ eq: (_k, id) => run('DELETE', `${base}/${id}`) }),
      insert: row => { const p = run('POST', base, row); return { select: () => ({ single: () => p }), then: (a, b) => p.then(a, b) }; },
    };
  } };

  document.title = ADMIN ? '포트폴리오 관리' : CFG.name;
  $('#brandName').textContent = CFG.name;
  if ($('#brandTag')) $('#brandTag').textContent = CFG.tagline || '';
  if ($('#contact')) $('#contact').textContent = CFG.contact || '';

  // ---------- 데이터 ----------
  let DATA = { sites: [], photos: [] }, siteById = {}, session = null, loaded = false;
  const CACHE = 'pf-cache-' + (ADMIN ? 'admin' : 'public');
  let MAINPDF = {}; // 현장별 메인파일 원본 PDF (고객 다운로드용)
  function setData(sites, photos) {
    const list = sites.map(s => ({ ...s, kind: 'site', info: s.info || {} }));
    const etc = { id: 'etc', name: CFG.etcName, kind: 'etc', info: {}, hidden: false };
    photos = photos.map(p => ({ ...p, site: p.site_id || 'etc' }));
    MAINPDF = {};
    photos = photos.filter(p => { if (p.type === 'mainpdf') { MAINPDF[p.site] = p; return false; } return true; });
    if (photos.some(p => p.site === 'etc')) list.push(etc);
    siteById = Object.fromEntries(list.map(s => [s.id, s]));
    photos = photos.filter(p => siteById[p.site] && (ADMIN || p.phase === 'after')); // 고객은 공사후 사진만
    DATA = { sites: list, photos };
  }
  try { const c = JSON.parse(localStorage.getItem(CACHE)); if (c) { setData(c.sites, c.photos); loaded = true; } } catch {}

  let version = null;
  async function fetchAll() {
    const d = await api('GET', '/data');
    version = d.v;
    // 로그인한 지 7일 넘었으면 조용히 연장 → 180일 안에 한 번이라도 열면 계속 로그인 유지
    const tk = getToken(), exp = tk ? +tk.split('.')[0] : 0;
    if (ADMIN && d.admin && exp && exp - Date.now() < 173 * 86400000)
      api('POST', '/refresh').then(r => { try { localStorage.setItem(TOKEN, r.token); } catch {} }).catch(() => {});
    setData(d.sites, d.photos);
    loaded = true;
    try { localStorage.setItem(CACHE, JSON.stringify({ sites: d.sites, photos: d.photos })); } catch {}
  }
  let reloadTimer = null, pendingReload = false;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (!$('#lb').hidden) { pendingReload = true; return; }
      try { await fetchAll(); render(); } catch (e) { console.warn(e); }
    }, 700);
  }
  // 다른 기기에서 바꾼 내용 자동 반영: 화면이 켜져 있으면 10초마다 변경 여부 확인
  async function checkVersion() {
    if (document.hidden) return;
    try { const { v } = await api('GET', '/version'); if (v !== version) scheduleReload(); } catch {}
  }
  function subscribe() {
    setInterval(checkVersion, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
    window.addEventListener('focus', checkVersion);
  }

  // ---------- 공통 ----------
  // 미분류: 관리 화면에선 맨 앞(분류할 것), 고객 화면에선 맨 뒤
  const spaceRank = s => { if (s === '미분류') return ADMIN ? -1 : 1000; const i = CFG.spaceOrder.indexOf(s); return i < 0 ? (s === '기타' ? 999 : 500) : i; };
  const spLabel = s => !ADMIN && s === '미분류' ? '기타' : s; // 고객에겐 미분류 대신 기타
  const sortSpaces = arr => [...new Set(arr)].sort((a, b) => spaceRank(a) - spaceRank(b) || a.localeCompare(b, 'ko'));
  const countBy = (arr, k) => arr.reduce((m, p) => (m[p[k]] = (m[p[k]] || 0) + 1, m), {});
  const allSpaces = () => sortSpaces([...CFG.spaceOrder, ...DATA.photos.map(p => p.space)]);
  const state = { phase: CFG.defaultPhase === 'all' ? 'all' : 'after', selMode: false, sel: new Set(), selSite: null };

  const photoHTML = (p, idx, opts = {}) => {
    const s = siteById[p.site];
    const ratio = p.w && p.h && !opts.strip ? ` style="aspect-ratio:${p.w}/${p.h}"` : '';
    const badge = p.phase !== 'after' && !opts.noBadge ? `<span class="badge ${p.phase}">${PH_NAME[p.phase]}</span>` : '';
    const cover = ADMIN && s.cover === p.id ? '<span class="badge cover">대표</span>' : '';
    const del = ADMIN ? '<button class="ph-del" type="button" aria-label="삭제" title="삭제">×</button><button class="ph-check" type="button" aria-label="선택" title="선택"></button>' : '';
    const play = p.type === 'video' ? '<span class="play" aria-label="동영상">▶</span>' : '';
    return `<figure class="ph" data-i="${idx}"${ratio}>${badge}${cover}${del}${play}
      <img src="${imgUrl(opts.large ? p.l : p.t)}" loading="lazy" alt="" draggable="false">
      ${opts.noCap ? '' : `<figcaption class="cap">${esc(p.phase !== 'after' ? PH_NAME[p.phase] : spLabel(p.space))} · ${esc(s.name)}</figcaption>`}</figure>`;
  };
  // 현장 메인파일 (PDF는 쪽마다 이미지로 저장됨) — 고객 링크에는 이것만 보임
  const isMain = p => p.type === 'main';
  const mainsOf = id => DATA.photos.filter(p => p.site === id && isMain(p)).sort((a, b) => (a.ord || 0) - (b.ord || 0));
  const coverOf = id => {
    const m = mainsOf(id);
    if (m.length) return m[0]; // 메인파일 첫 장이 현장 대표 사진
    const ps = DATA.photos.filter(p => p.site === id && !isMain(p)), s = siteById[id];
    const img = ps.filter(p => p.type !== 'video');
    return ps.find(p => p.id === s.cover) || img.find(p => p.phase === 'after' && p.space === '거실') || img.find(p => p.phase === 'after') || img[0] || ps[0] || m[0];
  };

  // ---------- 공간별 ----------
  function viewSpaces(space) {
    // 공간별 보기는 공사후 사진만 (공사전·공사중은 현장 페이지에서)
    const pool = DATA.photos.filter(p => p.phase === 'after' && !isMain(p) && p.space !== '미분류'); // 분류 끝난 사진만 (미분류는 현장 페이지에서 정리)
    const spaces = sortSpaces(pool.map(p => p.space));
    if (space && !spaces.includes(space)) space = null;
    const counts = countBy(pool, 'space');
    const list = space ? pool.filter(p => p.space === space) : pool.slice();
    const siteIdx = Object.fromEntries(DATA.sites.map((s, i) => [s.id, i]));
    list.sort((a, b) => siteIdx[a.site] - siteIdx[b.site]);
    app.innerHTML = `
      <div class="filters">
        <div class="chips">
          <a class="chip ${space ? '' : 'on'}" href="#/">전체<b>${pool.length}</b></a>
          ${spaces.map(s => `<a class="chip ${s === space ? 'on' : ''}" href="#/space/${encodeURIComponent(s)}">${esc(spLabel(s))}<b>${counts[s]}</b></a>`).join('')}
        </div>
        <div class="phase-row"><span class="count">공사후 · 분류된 사진 ${list.length}장</span></div>
      </div>
      ${list.length ? `<div class="grid">${list.map((p, i) => photoHTML(p, i)).join('')}</div>` : `<p class="none">공사후 사진이 아직 없어요.</p>`}`;
    bindPhotos(list);
  }

  // ---------- 현장별 ----------
  function viewSites() {
    const card = s => {
      const ps = DATA.photos.filter(p => p.site === s.id && !isMain(p));
      const nMain = mainsOf(s.id).length;
      const c = coverOf(s.id);
      const phases = PH_ORDER.filter(ph => ps.some(p => p.phase === ph));
      const meta = [s.info['위치'], s.info['평수'], s.info['연도']].filter(Boolean).join(' · ');
      return `<a class="card ${s.kind}" href="#/site/${s.id}">
        <div class="cover">${c ? `<img src="${imgUrl(c.t)}" loading="lazy" alt="" draggable="false">` : '<span class="nophoto">사진 없음</span>'}
          ${ADMIN && s.hidden ? '<span class="badge hid">고객에게 숨김</span>' : ''}</div>
        <div class="body">
          <h3><span>${esc(s.name)}</span>${ADMIN && ps.length ? `<small>${ps.length}장</small>` : ''}</h3>
          ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
          ${ADMIN ? `<div class="tags">
            ${(n => n ? `<span class="tag unc">미분류 ${n}</span>` : '')(ps.filter(p => p.phase === 'after' && p.space === '미분류').length)}
            ${phases.filter(ph => ph !== 'after').map(ph => `<span class="tag ph-${ph}">${PH_NAME[ph]} ${ps.filter(p => p.phase === ph).length}</span>`).join('')}
            ${(arr => sortSpaces(arr.map(p => p.space)).map(sp => `<span class="tag">${esc(sp)} ${arr.filter(p => p.space === sp).length}</span>`).join(''))(ps.filter(p => p.phase === 'after' && p.space !== '미분류' && p.space !== '기타'))}
          </div>` : ''}
        </div></a>`;
    };
    const real = DATA.sites.filter(s => s.kind === 'site' && (ADMIN || DATA.photos.some(p => p.site === s.id)));
    const etc = DATA.sites.filter(s => s.kind === 'etc');
    app.innerHTML = `
      ${ADMIN ? adminLinkBox() : ''}
      ${real.length ? `<h2 class="section-title">현장 ${real.length}곳</h2><div class="cards">${real.map(card).join('')}</div>` : ''}
      ${etc.length ? `<h2 class="section-title">현장명 없는 작업물</h2><div class="cards">${etc.map(card).join('')}</div>` : ''}
      ${!real.length && !etc.length ? '<p class="none">아직 현장이 없어요.</p>' : ''}`;
    if (ADMIN) bindLinkBox();
  }

  function viewSite(id) {
    const s = siteById[id];
    if (!s) return (location.hash = '#/sites');
    if (!ADMIN) return viewSitePublic(s);
    const ps = DATA.photos.filter(p => p.site === id && !isMain(p));
    const mains = mainsOf(id);
    if (state.selSite !== id) { state.selSite = id; state.sel.clear(); state.pending = {}; }
    state.selMode = ADMIN; // 관리 화면: 현장에 들어가면 바로 사진을 골라서 분류
    for (const sid of [...state.sel]) if (!ps.some(p => p.id === sid)) state.sel.delete(sid);
    // 공사전 사진은 공간 구분 없이 한 묶음 ("공사전" 칸)
    const GROUP = { before: '__before', during: '__during' }; // 공사전·공사중은 공간 구분 없이 한 묶음
    const keyOf = p => GROUP[p.phase] || p.space;
    const spaces = sortSpaces(ps.filter(p => p.phase === 'after').map(p => p.space));
    if (ps.some(p => p.phase === 'during')) spaces.push(GROUP.during);
    if (ps.some(p => p.phase === 'before')) spaces.push(GROUP.before);
    const groupPh = sp => sp === GROUP.before ? 'before' : sp === GROUP.during ? 'during' : null;
    const secName = sp => groupPh(sp) ? PH_NAME[groupPh(sp)] : spLabel(sp);
    const ordered = [];
    const blocks = spaces.map(sp => {
      const inSpace = ps.filter(p => keyOf(p) === sp);
      const phases = PH_ORDER.filter(ph => inSpace.some(p => p.phase === ph));
      const rows = phases.map(ph => {
        const html = inSpace.filter(p => p.phase === ph).map(p => photoHTML(p, ordered.push(p) - 1, { strip: true, noBadge: true, noCap: true })).join('');
        return phases.length > 1 || (s.kind === 'site' && ph !== 'after')
          ? `<div class="phase-block"><div class="lbl"><span class="badge ${ph}">${PH_NAME[ph]}</span></div><div class="strip">${html}</div></div>`
          : `<div class="strip">${html}</div>`;
      }).join('');
      const selAll = ADMIN && state.selMode ? `<button class="btn small" type="button" data-selall="${esc(sp)}">${inSpace.every(p => state.sel.has(p.id)) ? '선택 해제' : '전체 선택'}</button>` : '';
      return `<section class="space-sec" id="sp-${encodeURIComponent(sp)}"><h2>${groupPh(sp) ? `<span class="badge ${groupPh(sp)}">${secName(sp)}</span>` : esc(secName(sp))} <small>${inSpace.length}장</small> ${selAll}</h2>${rows}</section>`;
    }).join('');
    const c = coverOf(id);
    const info = Object.entries(s.info).filter(([k, v]) => k !== '설명' && v);
    const pc = countBy(ps, 'phase');
    app.innerHTML = `
      <a class="back" href="#/sites">← 현장 목록</a>
      <div class="site-head">
        <div class="hero" id="hero">${c ? `<img src="${imgUrl(c.type === 'video' ? c.t : c.l)}" alt="" draggable="false">` : ''}</div>
        <div>
          <h1>${esc(s.name)} ${ADMIN && s.hidden ? '<span class="badge hid">고객에게 숨김</span>' : ''}</h1>
          ${info.length ? `<dl class="info">${info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
          ${s.info['설명'] ? `<p class="desc">${esc(s.info['설명'])}</p>` : ''}
          <div class="phase-sum" ${ADMIN ? '' : 'hidden'}>${PH_ORDER.filter(ph => pc[ph]).map(ph => `<span class="badge ${ph}">${PH_NAME[ph]} ${pc[ph]}</span>`).join('')}</div>
          ${ADMIN ? siteAdminBar(s) : ''}
        </div>
      </div>
      ${ADMIN ? '<div id="siteEdit"></div>' : ''}
      ${s.kind === 'site' ? mainSecHTML(mains) : ''}
      ${spaces.length ? `<div class="filters"><div class="chips">
        ${spaces.map(sp => `<button class="chip" data-jump="${esc(sp)}">${esc(secName(sp))}<b>${ps.filter(p => keyOf(p) === sp).length}</b></button>`).join('')}
      </div></div>` : '<p class="none">아직 사진이 없어요.</p>'}
      ${blocks}`;
    app.querySelectorAll('[data-jump]').forEach(b => b.onclick = () =>
      document.getElementById('sp-' + encodeURIComponent(b.dataset.jump)).scrollIntoView({ behavior: 'smooth' }));
    if (c) $('#hero').onclick = () => isMain(c) ? openLB(mains, mains.indexOf(c)) : openLB(ordered, ordered.indexOf(c));
    bindPhotos(ordered);
    if (ADMIN) { bindSiteAdmin(s); bindSelect(s, ps, ordered, keyOf); bindMain(s, mains); }
  }

  // ---------- 메인파일 ----------
  function mainSecHTML(mains) {
    return `<section class="main-sec">
      <h2>메인파일 <small>${mains.length ? `${mains.length}쪽 · ` : ''}고객 링크에는 이것만 보여요</small></h2>
      ${mains.length ? `<div class="main-strip">${mains.map((p, i) => photoHTML(p, i, { strip: true, noBadge: true, noCap: true })).join('')}</div>`
        : '<p class="help">아직 메인파일이 없어요. 메인파일이 없는 현장은 고객 링크에 안 보여요.</p>'}
      <div class="adminbar">
        <label class="btn primary"><input type="file" id="mainFile" accept="application/pdf,.pdf,image/*,.dng" multiple hidden>${mains.length ? '메인파일 바꾸기' : '＋ 메인파일 올리기 (PDF·이미지)'}</label>
        ${mains.length ? '<button class="btn danger" type="button" id="mainDel">메인파일 삭제</button>' : ''}
      </div>
      <div id="mainProg"></div>
    </section>`;
  }
  function bindMain(s, mains) {
    app.querySelectorAll('.main-sec .ph').forEach((el, i) => el.onclick = e => {
      e.stopPropagation();
      if (e.target.closest('.ph-del')) return deletePhoto(mains[i]);
      openLB(mains, i);
    });
    const f = $('#mainFile');
    if (f) f.onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) uploadMain(s, files); };
    const d = $('#mainDel');
    if (d) d.onclick = async () => {
      if (!confirm('메인파일을 삭제할까요? 이 현장은 고객 링크에서 안 보이게 돼요.')) return;
      try { await api('POST', '/photos/batch-delete', { ids: mains.map(p => p.id).concat(MAINPDF[s.id] ? [MAINPDF[s.id].id] : []) }); } catch (err) { return toast('삭제 실패: ' + err.message); }
      delete MAINPDF[s.id];
      const gone = new Set(mains.map(p => p.id));
      DATA.photos = DATA.photos.filter(p => !gone.has(p.id));
      usage = null; toast('메인파일을 삭제했어요'); render();
    };
  }
  let pdfjsP = null;
  function loadPdfJs() {
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299/';
    return pdfjsP || (pdfjsP = import(base + 'pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs'; return m; }));
  }
  // PDF는 쪽마다 이미지로 바꿔서, 이미지는 그대로 → 순서대로 올리고, 다 되면 예전 메인파일 지우기
  async function uploadMain(s, files) {
    const say = t => { const el = $('#mainProg'); if (el) el.innerHTML = t ? `<p class="help"><b>${t}</b></p>` : ''; };
    const busy = v => { const l = app.querySelector('.main-sec label.btn'); if (l) l.classList.toggle('disabled', v); };
    busy(true);
    const pages = [];
    const pdfFile = files.length === 1 && (files[0].type === 'application/pdf' || /\.pdf$/i.test(files[0].name)) ? files[0] : null;
    try {
      for (const f of files) {
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          say('PDF 여는 중…');
          const pdfjs = await loadPdfJs();
          const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
          for (let i = 1; i <= doc.numPages; i++) {
            say(`PDF를 이미지로 바꾸는 중… ${i} / ${doc.numPages}쪽`);
            const page = await doc.getPage(i);
            const v1 = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: Math.min(8, 4000 / Math.max(v1.width, v1.height)) }); // 메인파일은 확대해도 선명하게 4000px
            const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
            const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
            await page.render({ canvasContext: g, viewport: vp, canvas: c, intent: 'print' }).promise;
            pages.push({ src: c, name: `${f.name} ${i}쪽` });
            page.cleanup();
          }
          try { if (typeof doc.destroy === 'function') await doc.destroy(); else if (typeof doc.cleanup === 'function') await doc.cleanup(); } catch {}
        } else if (isVideoFile(f)) toast('메인파일은 PDF나 이미지만 올릴 수 있어요');
        else pages.push({ src: isDng(f) ? await dngPreview(f) : await loadImg(f), name: f.name });
      }
    } catch (e) { say(''); busy(false); return toast('파일을 열 수 없어요: ' + (e.message || e), 4000); }
    if (!pages.length) { say(''); busy(false); return; }
    const old = mainsOf(s.id), oldPdf = MAINPDF[s.id], added = [];
    try {
      for (let i = 0; i < pages.length; i++) {
        say(`올리는 중… ${i + 1} / ${pages.length}`);
        const large = await toJpeg(pages[i].src, 4000, 0.92), thumb = await toJpeg(pages[i].src, 1400, 0.86); // 메인파일: 크게 4000px, 목록용 1400px
        const id = crypto.randomUUID(), t = `ph/${id}_t.jpg`, l = `ph/${id}_l.jpg`;
        await putFile(t, thumb.blob);
        await putFile(l, large.blob);
        const row = { id, type: 'main', ord: i, site_id: s.id, phase: 'after', space: '메인파일', t, l, w: thumb.w, h: thumb.h, src_name: pages[i].name, src_size: large.blob.size };
        const ins = await sb.from('pf_photos').insert(row);
        if (ins.error) throw ins.error;
        added.push({ ...row, site: s.id });
      }
      if (pdfFile) { // 고객이 그대로 받을 수 있게 원본 PDF 보관
        say('원본 PDF 저장 중…');
        const id = crypto.randomUUID(), key = `ph/${id}_doc.pdf`;
        await putFile(key, pdfFile, 'application/pdf');
        const row = { id, type: 'mainpdf', ord: 0, site_id: s.id, phase: 'after', space: '메인파일', t: key, l: key, w: 0, h: 0, src_name: pdfFile.name, src_size: pdfFile.size };
        const ins = await sb.from('pf_photos').insert(row);
        if (ins.error) throw ins.error;
        MAINPDF[s.id] = { ...row, site: s.id };
      } else delete MAINPDF[s.id];
    } catch (e) {
      if (added.length) await api('POST', '/photos/batch-delete', { ids: added.map(a => a.id) }).catch(() => {});
      say(''); busy(false); return toast('올리기 실패: ' + (e.message || e), 4000);
    }
    const oldIds = old.map(p => p.id).concat(oldPdf && (!MAINPDF[s.id] || MAINPDF[s.id].id !== oldPdf.id) ? [oldPdf.id] : []);
    if (oldIds.length) await api('POST', '/photos/batch-delete', { ids: oldIds }).catch(() => {});
    const gone = new Set(old.map(p => p.id));
    DATA.photos = DATA.photos.filter(p => !gone.has(p.id)).concat(added);
    usage = null; toast(`메인파일 ${added.length}쪽을 올렸어요`); render();
  }
  // 고객 링크: 메인파일 + 공사후 현장 사진(공간별). 다운로드는 메인파일 원본 PDF만
  function viewSitePublic(s) {
    const mains = mainsOf(s.id);
    const info = Object.entries(s.info).filter(([k, v]) => k !== '설명' && v);
    const ps = DATA.photos.filter(p => p.site === s.id && !isMain(p) && p.phase === 'after' && p.space !== '미분류');
    if (!mains.length && !ps.length) return (location.hash = '#/sites');
    const spaces = sortSpaces(ps.map(p => p.space));
    const all = [...mains]; // 크게 보기에서 메인파일 → 현장 사진 순서로 넘어가게 한 목록
    const mainHTML = mains.map(p => photoHTML(p, all.indexOf(p), { noBadge: true, noCap: true })).join('');
    const blocks = spaces.map(sp => {
      const inSp = ps.filter(p => p.space === sp);
      return `<section class="space-sec"><h2>${esc(spLabel(sp))} <small>${inSp.length}장</small></h2>
        <div class="strip">${inSp.map(p => photoHTML(p, all.push(p) - 1, { strip: true, noBadge: true, noCap: true })).join('')}</div></section>`;
    }).join('');
    const pdf = MAINPDF[s.id];
    app.innerHTML = `
      <a class="back" href="#/sites">← 현장 목록</a>
      <div class="pub-head">
        <h1>${esc(s.name)}</h1>
        ${info.length ? `<dl class="info">${info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
        ${s.info['설명'] ? `<p class="desc">${esc(s.info['설명'])}</p>` : ''}
        ${pdf ? '<button class="btn primary dl-main" type="button" id="dlMain">⬇ 메인파일 PDF 다운로드</button>' : ''}
      </div>
      ${mains.length ? `<div class="main-pages">${mainHTML}</div>` : ''}
      ${ps.length ? `<h2 class="section-title pub-photos">현장 사진 <small>${ps.length}장</small></h2>${blocks}` : ''}`;
    bindPhotos(all);
    if (pdf) $('#dlMain').onclick = () => downloadMain(s);
  }
  // 메인파일로 올린 원본 PDF 그대로 내려받기
  async function downloadMain(s) {
    const pdf = MAINPDF[s.id]; if (!pdf) return;
    const btn = $('#dlMain'), label = btn.textContent;
    btn.disabled = true; btn.textContent = '받는 중…';
    try {
      const r = await fetch(imgUrl(pdf.l));
      if (!r.ok) throw new Error('파일을 못 받았어요');
      const u = URL.createObjectURL(await r.blob()), a = document.createElement('a');
      a.href = u; a.download = `${s.name.replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30000);
    } catch (e) { toast('다운로드 실패: ' + (e.message || e), 4000); }
    btn.disabled = false; btn.textContent = label;
  }

  // ---------- 라이트박스 ----------
  let lbList = [], lbI = 0;
  function bindPhotos(list) {
    app.querySelectorAll('.ph[data-i]').forEach(el => !el.closest('.main-sec') && (el.onclick = e => {
      if (ADMIN && e.target.closest('.ph-del')) { e.stopPropagation(); return deletePhoto(list[+el.dataset.i]); }
      // 왼쪽 위 동그라미 = 선택, 사진 자체를 누르면 크게 보기
      if (ADMIN && state.selMode && el.closest('.space-sec') && e.target.closest('.ph-check')) { const p = list[+el.dataset.i]; state.sel.has(p.id) ? state.sel.delete(p.id) : state.sel.add(p.id); el.classList.toggle('selected', state.sel.has(p.id)); return updateSelBar(); }
      openLB(list, +el.dataset.i);
    }));
  }
  async function deletePhoto(p) {
    if (!p || !confirm('이 사진을 삭제할까요? 되돌릴 수 없어요.')) return false;
    const { error } = await sb.from('pf_photos').delete().eq('id', p.id);
    if (error) { toast('삭제 실패: ' + error.message); return false; }
    DATA.photos = DATA.photos.filter(x => x.id !== p.id);
    const s = siteById[p.site]; if (s && s.cover === p.id) s.cover = null;
    usage = null; toast('삭제했어요'); render();
    return true;
  }
  function openLB(list, i) { if (!list.length) return; lbList = list; lbI = i; $('#lb').hidden = false; document.body.style.overflow = 'hidden'; showLB(); }
  function closeLB() {
    if ($('#lb').hidden) return;
    $('#lb').hidden = true; document.body.style.overflow = '';
    const vid = $('#lbVid'); vid.pause(); vid.removeAttribute('src'); vid.dataset.src = ''; vid.load();
    if (pendingReload) { pendingReload = false; scheduleReload(); }
  }
  function showLB() {
    const p = lbList[lbI], s = siteById[p.site];
    if (!p || !s) return closeLB();
    const vid = $('#lbVid'), isVid = p.type === 'video';
    $('#lbImg').hidden = isVid; vid.hidden = !isVid;
    if (isVid) { if (vid.dataset.src !== p.l) { vid.dataset.src = p.l; vid.poster = imgUrl(p.t); vid.src = imgUrl(p.l); } }
    else { vid.pause(); vid.removeAttribute('src'); vid.dataset.src = ''; vid.load(); $('#lbImg').src = imgUrl(p.l); }
    zReset();
    $('#lbCap').textContent = isMain(p) ? `${s.name}${lbList.length > 1 ? ` · ${(p.ord || 0) + 1} / ${lbList.length}쪽` : ''}` : p.phase !== 'after' ? `${s.name} · ${PH_NAME[p.phase]}` : `${s.name} · ${spLabel(p.space)} · ${PH_NAME[p.phase]}`;
    $('#lbSite').href = '#/site/' + s.id;
    $('#lbSite').hidden = location.hash === '#/site/' + s.id;
    $('#lbN').textContent = `${lbI + 1} / ${lbList.length}`;
    [lbList[lbI + 1], lbList[lbI - 1]].forEach(n => n && n.type !== 'video' && (new Image().src = imgUrl(n.l)));
    if (ADMIN && !isMain(p)) lbEditor(p); else $('#lbEdit').innerHTML = '';
  }
  const step = d => { lbI = (lbI + d + lbList.length) % lbList.length; showLB(); };
  $('#lbClose').onclick = closeLB;
  $('#lbPrev').onclick = () => step(-1);
  $('#lbNext').onclick = () => step(1);
  $('#lbSite').onclick = closeLB;
  $('#lb').onclick = e => { if (e.target.id === 'lb') closeLB(); };
  document.addEventListener('keydown', e => {
    if ($('#lb').hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'Escape') closeLB();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
    if (e.key === '+' || e.key === '=') zSet(Z.s * 1.4);
    if (e.key === '-') zSet(Z.s / 1.4);
  });
  let tx = null;
  // 넘기기(스와이프): 동영상 위, 두 손가락, 확대 중에는 안 함
  $('#lb').addEventListener('touchstart', e => { tx = e.target.tagName === 'VIDEO' || e.touches.length > 1 || Z.s > 1.01 ? null : e.touches[0].clientX; }, { passive: true });
  $('#lb').addEventListener('touchend', e => {
    if (tx == null || Z.s > 1.01) { tx = null; return; }
    const dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });

  // ---------- 사진 확대/축소 + 드래그 ----------
  // 최대 배율 = 사진 원래 크기까지 (그 이상은 깨져 보이므로 막음)
  const Z = { s: 1, x: 0, y: 0, max: 1, pts: new Map(), last: null, pinch: null, moved: false, tap: 0, tapX: 0, tapY: 0 };
  const zBox = $('.lb-img'), zImg = $('#lbImg');
  zImg.draggable = false;
  function zApply() {
    const w = zBox.clientWidth, h = zBox.clientHeight;
    Z.x = Math.min(0, Math.max(w - w * Z.s, Z.x));
    Z.y = Math.min(0, Math.max(h - h * Z.s, Z.y));
    zImg.style.transform = Z.s <= 1.001 ? '' : `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
    zBox.classList.toggle('zoomed', Z.s > 1.001);
    $('#zPct').textContent = Math.round(Z.s * 100) + '%';
    $('#zIn').disabled = Z.s >= Z.max - 0.001;
    $('#zOut').disabled = Z.s <= 1.001;
  }
  function zSet(s, px, py) { // (px, py) 지점을 중심으로 확대
    if (Z.max <= 1) return;
    if (px == null) { px = zBox.clientWidth / 2; py = zBox.clientHeight / 2; }
    s = Math.min(Z.max, Math.max(1, s));
    const ux = (px - Z.x) / Z.s, uy = (py - Z.y) / Z.s;
    Z.s = s; Z.x = px - ux * s; Z.y = py - uy * s;
    zApply();
  }
  function zReset() {
    Z.s = 1; Z.x = 0; Z.y = 0; Z.pts.clear(); Z.pinch = null; Z.last = null;
    const calc = () => {
      Z.max = zImg.hidden || !zImg.clientWidth ? 1 : Math.max(1, zImg.naturalWidth / zImg.clientWidth);
      $('#lbZoom').hidden = Z.max < 1.15;
      zApply();
    };
    $('#lbZoom').hidden = true;
    if (zImg.complete && zImg.naturalWidth) calc(); else zImg.onload = calc;
  }
  const boxPt = (x, y) => { const r = zBox.getBoundingClientRect(); return [x - r.left, y - r.top]; };
  zBox.addEventListener('wheel', e => {
    if ($('#lb').hidden || Z.max <= 1) return;
    e.preventDefault();
    zSet(Z.s * Math.exp(-e.deltaY * 0.0018), ...boxPt(e.clientX, e.clientY));
  }, { passive: false });
  zBox.addEventListener('pointerdown', e => {
    if (Z.max <= 1 || e.target.tagName === 'VIDEO') return;
    zBox.setPointerCapture(e.pointerId);
    Z.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    Z.moved = false;
    if (Z.pts.size === 2) { const [a, b] = [...Z.pts.values()]; Z.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: Z.s }; }
    else Z.last = { x: e.clientX, y: e.clientY };
    if (Z.s > 1.001) zBox.classList.add('dragging');
  });
  zBox.addEventListener('pointermove', e => {
    if (!Z.pts.has(e.pointerId)) return;
    Z.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Z.pts.size >= 2 && Z.pinch) {
      const [a, b] = [...Z.pts.values()];
      zSet(Z.pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / Z.pinch.d, ...boxPt((a.x + b.x) / 2, (a.y + b.y) / 2));
      Z.moved = true;
    } else if (Z.last) {
      const dx = e.clientX - Z.last.x, dy = e.clientY - Z.last.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) Z.moved = true;
      if (Z.s > 1.001) { Z.x += dx; Z.y += dy; zApply(); }
      Z.last = { x: e.clientX, y: e.clientY };
    }
  });
  const zUp = e => {
    if (!Z.pts.has(e.pointerId)) return;
    Z.pts.delete(e.pointerId);
    if (Z.pts.size < 2) Z.pinch = null;
    if (Z.pts.size === 1) { const [a] = Z.pts.values(); Z.last = { x: a.x, y: a.y }; } else Z.last = null;
    zBox.classList.remove('dragging');
    // 두 번 톡톡(더블클릭) → 확대 / 원래대로
    if (e.type === 'pointerup' && !Z.moved && !Z.pts.size) {
      const now = Date.now();
      if (now - Z.tap < 320 && Math.abs(e.clientX - Z.tapX) < 30 && Math.abs(e.clientY - Z.tapY) < 30) {
        Z.tap = 0;
        zSet(Z.s > 1.01 ? 1 : Math.min(Z.max, 2.5), ...boxPt(e.clientX, e.clientY));
      } else { Z.tap = now; Z.tapX = e.clientX; Z.tapY = e.clientY; }
    }
  };
  zBox.addEventListener('pointerup', zUp);
  zBox.addEventListener('pointercancel', zUp);
  $('#zIn').onclick = e => { e.stopPropagation(); zSet(Z.s * 1.5); };
  $('#zOut').onclick = e => { e.stopPropagation(); zSet(Z.s / 1.5); };
  window.addEventListener('resize', () => { if (!$('#lb').hidden) zReset(); });

  // ---------- 고객 링크: 저장/캡처 방지 ----------
  if (!ADMIN) {
    const root = document.documentElement;
    root.classList.add('protect');
    const wm = CFG.watermark === false ? '' : (CFG.watermark || CFG.name);
    if (wm) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="190"><text x="150" y="105" text-anchor="middle" transform="rotate(-24 150 95)" font-family="Pretendard, sans-serif" font-size="17" font-weight="600" fill="white" fill-opacity="0.32" stroke="black" stroke-opacity="0.10" stroke-width="0.6">${esc(wm)}</text></svg>`;
      root.style.setProperty('--wm', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    }
    const stop = e => { e.preventDefault(); return false; };
    ['contextmenu', 'dragstart', 'selectstart', 'copy', 'cut'].forEach(ev => document.addEventListener(ev, stop, true));
    document.addEventListener('touchstart', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    let shieldTimer;
    const shield = (ms) => {
      root.classList.add('shield');
      clearTimeout(shieldTimer);
      if (ms) shieldTimer = setTimeout(() => root.classList.remove('shield'), ms);
    };
    const unshield = () => root.classList.remove('shield');
    const isWin = /Win/i.test(navigator.platform || navigator.userAgent);
    document.addEventListener('keydown', e => {
      const k = (e.key || '').toLowerCase();
      if (k === 'printscreen' || k === 'f12' ||
          ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u', 'c'].includes(k)) ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c', 's', '3', '4', '5'].includes(k))) {
        e.preventDefault(); shield(2500);
      }
      // 캡처 단축키 시작 키에서 미리 가리기: 맥 Cmd+Shift, 윈도우 Win 키
      if ((e.metaKey && e.shiftKey) || (isWin && k === 'meta')) shield(2500);
    }, true);
    document.addEventListener('keyup', e => {
      if ((e.key || '').toLowerCase() === 'printscreen') {
        shield(2500);
        try { navigator.clipboard.writeText(''); } catch {}
      }
    }, true);
    // 창이 포커스를 잃으면(캡처 도구 실행 등) 사진 가리기 — 터치 기기는 제외
    if (!matchMedia('(hover: none)').matches) {
      window.addEventListener('blur', () => shield());
      window.addEventListener('focus', unshield);
      document.addEventListener('pointerdown', unshield, true);
    }
    document.addEventListener('visibilitychange', () => document.hidden ? shield() : unshield());
  }

  // ======================================================================
  // 관리자 전용
  // ======================================================================
  const toast = (msg, ms = 2200) => {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms);
  };
  const customerLink = () => new URL('./', location.href).href.replace(/admin\.html.*$/, '');

  function adminLinkBox() {
    return `<div class="linkbox"><div><b>고객용 링크</b><span>${esc(customerLink())}</span></div>
      <button class="btn" id="copyLink">링크 복사</button></div>`;
  }
  function bindLinkBox() {
    const b = $('#copyLink'); if (!b) return;
    b.onclick = async () => {
      const url = customerLink();
      try {
        if (navigator.share && matchMedia('(hover: none)').matches) await navigator.share({ title: CFG.name, url });
        else { await navigator.clipboard.writeText(url); toast('고객용 링크를 복사했어요'); }
      } catch {}
    };
  }

  function viewLogin(msg = '') {
    app.innerHTML = `<form class="login" id="login">
      <h2>관리자 로그인</h2>
      <p>포트폴리오 관리 비밀번호를 입력하세요.</p>
      <input type="text" name="username" value="portfolio-admin" autocomplete="username" hidden>
      <input type="password" id="lgPw" placeholder="비밀번호" autocomplete="current-password" required>
      <button class="btn primary" type="submit">로그인</button>
      <p class="err">${esc(msg)}</p></form>`;
    $('#login').onsubmit = async e => {
      e.preventDefault();
      let token;
      try { ({ token } = await api('POST', '/login', { password: $('#lgPw').value })); }
      catch (err) { return viewLogin(err.message || '로그인 실패'); }
      try { localStorage.setItem(TOKEN, token); } catch {}
      session = token;
      await afterLogin();
    };
  }

  // --- 현장 편집 ---
  function siteAdminBar(s) {
    if (s.kind === 'etc') return `<div class="adminbar"><a class="btn" href="#/upload?site=etc">＋ 사진 추가</a></div>`;
    return `<div class="adminbar">
      <a class="btn" href="#/upload?site=${s.id}">＋ 사진 추가</a>
      <button class="btn" data-a="edit">정보 수정</button>
      <button class="btn" data-a="hide">${s.hidden ? '고객에게 보이기' : '고객에게 숨기기'}</button>
      <button class="btn danger" data-a="del">현장 삭제</button></div>`;
  }
  function bindSiteAdmin(s) {
    if (s.kind === 'etc') return;
    const act = a => app.querySelector(`[data-a="${a}"]`);
    act('hide').onclick = async () => {
      const { error } = await sb.from('pf_sites').update({ hidden: !s.hidden }).eq('id', s.id);
      if (error) return toast('실패: ' + error.message);
      s.hidden = !s.hidden; toast(s.hidden ? '고객 링크에서 숨겼어요' : '고객 링크에 보여요'); render();
    };
    act('del').onclick = async () => {
      const ps = DATA.photos.filter(p => p.site === s.id);
      if (!confirm(`"${s.name}" 현장과 사진 ${ps.length}장을 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
      const { error } = await sb.from('pf_sites').delete().eq('id', s.id);
      if (error) return toast('실패: ' + error.message);
      location.hash = '#/sites'; scheduleReload();
    };
    act('edit').onclick = () => {
      const f = ['위치', '평수', '연도'];
      $('#siteEdit').innerHTML = `<form class="panel" id="siteForm">
        <label>현장 이름<input name="name" value="${esc(s.name)}" required></label>
        <div class="row3">${f.map(k => `<label>${k}<input name="${k}" value="${esc(s.info[k] || '')}"></label>`).join('')}</div>
        <label>설명<textarea name="설명" rows="3">${esc(s.info['설명'] || '')}</textarea></label>
        <div class="adminbar"><button class="btn primary">저장</button><button class="btn" type="button" id="cancelEdit">취소</button></div></form>`;
      $('#cancelEdit').onclick = () => $('#siteEdit').innerHTML = '';
      $('#siteForm').onsubmit = async e => {
        e.preventDefault();
        const fd = new FormData(e.target), info = {};
        for (const k of [...f, '설명']) if (fd.get(k).trim()) info[k] = fd.get(k).trim();
        const name = fd.get('name').trim();
        const { error } = await sb.from('pf_sites').update({ name, info }).eq('id', s.id);
        if (error) return toast('실패: ' + error.message);
        s.name = name; s.info = info; toast('저장했어요'); render();
      };
    };
  }

  // --- 여러 장 골라서 분류하기 ---
  let selCtx = null;
  function bindSelect(s, ps, ordered, keyOf) {
    selCtx = { s, ps, ordered };
    const btn = app.querySelector('[data-a="classify"]');
    if (btn) {
      btn.textContent = state.selMode ? '분류 끝내기' : '☑ 사진 분류하기';
      btn.onclick = () => { state.selMode = !state.selMode; state.sel.clear(); state.pending = {}; render(); if (state.selMode) toast('사진을 고르고 → 단계·공간을 정한 뒤 → 완료', 3500); };
    }
    app.classList.toggle('sel-mode', !!state.selMode);
    if (state.selMode) {
      app.querySelectorAll('.space-sec .ph[data-i]').forEach(el => el.classList.toggle('selected', state.sel.has(ordered[+el.dataset.i].id)));
      app.querySelectorAll('[data-selall]').forEach(b => b.onclick = () => {
        const inSp = ps.filter(p => keyOf(p) === b.dataset.selall);
        const all = inSp.every(p => state.sel.has(p.id));
        inSp.forEach(p => all ? state.sel.delete(p.id) : state.sel.add(p.id));
        render();
      });
    }
    updateSelBar();
  }
  function updateSelBar() {
    let bar = $('#selBar');
    const on = ADMIN && state.selMode && selCtx && location.hash.startsWith('#/site/');
    if (!on) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'selBar'; bar.className = 'selbar'; document.body.appendChild(bar); }
    const n = state.sel.size, sites = DATA.sites.filter(x => x.kind === 'site');
    const pd = state.pending || (state.pending = {});
    const spaces = [...allSpaces().filter(x => x !== '기타' && x !== '미분류'), '미분류'];
    if (pd.space && !spaces.includes(pd.space)) spaces.splice(spaces.length - 1, 0, pd.space);
    const siteName = v => v === 'etc' ? CFG.etcName : (siteById[v] || {}).name;
    // 고른 내용 요약 → 완료 버튼에 표시
    if (pd.phase && pd.phase !== 'after') pd.space = undefined; // 공사전·공사중은 공간 구분 안 함
    const summary = [pd.phase && PH_NAME[pd.phase], pd.space, pd.site && '→ ' + siteName(pd.site)].filter(Boolean).join(' · ');
    const ready = n && summary;
    bar.innerHTML = `
      <div class="selinfo"><b>${n}장 선택</b>
        <button type="button" data-s="all">현장 전체 선택</button><button type="button" data-s="none" ${n ? '' : 'disabled'}>선택 해제</button></div>
      <div class="selact">
        <select data-s="phase"><option value="">단계 정하기…</option>${PH_ORDER.map(ph => `<option value="${ph}" ${pd.phase === ph ? 'selected' : ''}>${PH_NAME[ph]}</option>`).join('')}</select>
        <select data-s="space" ${pd.phase && pd.phase !== 'after' ? 'disabled' : ''}><option value="">${pd.phase && pd.phase !== 'after' ? `공간 없음 (${PH_NAME[pd.phase]})` : '공간 정하기…'}</option>${spaces.map(sp => `<option ${pd.space === sp ? 'selected' : ''}>${esc(sp)}</option>`).join('')}<option value="__new">+ 새 공간…</option></select>
        <select data-s="site"><option value="">다른 현장으로…</option><option value="etc" ${pd.site === 'etc' ? 'selected' : ''}>${esc(CFG.etcName)}</option>${sites.filter(x => x.id !== selCtx.s.id).map(x => `<option value="${x.id}" ${pd.site === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <button type="button" data-s="del" class="danger" ${n ? '' : 'disabled'}>삭제</button>
        <button type="button" data-s="apply" class="apply" ${ready ? '' : 'disabled'}>${ready ? `완료 — ${n}장을 ${esc(summary)}(으)로` : n ? '단계·공간을 고른 뒤 완료' : '사진 왼쪽 위 ○를 눌러 고르세요'}</button>
      </div>`;
    const q = k => bar.querySelector(`[data-s="${k}"]`);
    q('all').onclick = () => { selCtx.ps.forEach(p => state.sel.add(p.id)); render(); };
    q('none').onclick = () => { state.sel.clear(); render(); };
    // 고르기만 하고, 실제로 바뀌는 건 「완료」를 눌렀을 때
    q('phase').onchange = e => { pd.phase = e.target.value || undefined; updateSelBar(); };
    q('space').onchange = e => {
      let v = e.target.value;
      if (v === '__new') { v = prompt('공간 이름 (예: 드레스룸, 팬트리)'); v = v && v.trim() ? spaceOf(v.trim()) : pd.space; }
      pd.space = v || undefined; updateSelBar();
    };
    q('site').onchange = e => { pd.site = e.target.value || undefined; updateSelBar(); };
    q('apply').onclick = () => {
      if (!ready) return;
      const patch = {};
      if (pd.phase) patch.phase = pd.phase;
      if (pd.space) patch.space = pd.space;
      if (pd.site) patch.site_id = pd.site === 'etc' ? null : pd.site;
      state.pending = {};
      applyBatch(patch, `${n}장을 ${summary}(으)로 정리했어요`);
    };
    q('del').onclick = async () => {
      if (!confirm(`선택한 ${n}장을 삭제할까요? 되돌릴 수 없어요.`)) return;
      const ids = [...state.sel];
      try { await api('POST', '/photos/batch-delete', { ids }); } catch (err) { return toast('삭제 실패: ' + err.message); }
      const gone = new Set(ids);
      DATA.photos = DATA.photos.filter(p => !gone.has(p.id));
      state.sel.clear(); usage = null; toast(`${ids.length}장 삭제했어요`); render();
    };
  }
  async function applyBatch(patch, msg) {
    const ids = [...state.sel];
    try { await api('POST', '/photos/batch', { ids, patch }); } catch (err) { toast('실패: ' + err.message); return render(); }
    const set = new Set(ids);
    for (const p of DATA.photos) if (set.has(p.id)) { Object.assign(p, patch); if ('site_id' in patch) p.site = patch.site_id || 'etc'; }
    if ('site_id' in patch && patch.site_id === null && !siteById.etc) { const etc = { id: 'etc', name: CFG.etcName, kind: 'etc', info: {}, hidden: false }; DATA.sites.push(etc); siteById.etc = etc; }
    state.sel.clear(); toast(msg, 2500); render();
  }

  // --- 사진 편집 (라이트박스 아래) ---
  function lbEditor(p) {
    const sites = DATA.sites.filter(s => s.kind === 'site');
    const s = siteById[p.site];
    $('#lbEdit').innerHTML = `<div class="lb-edit">
      <select data-e="space">${allSpaces().map(sp => `<option ${sp === p.space ? 'selected' : ''}>${esc(sp)}</option>`).join('')}<option value="__new">+ 새 공간…</option></select>
      <select data-e="phase">${PH_ORDER.map(ph => `<option value="${ph}" ${ph === p.phase ? 'selected' : ''}>${PH_NAME[ph]}</option>`).join('')}</select>
      <select data-e="site"><option value="etc" ${p.site === 'etc' ? 'selected' : ''}>${esc(CFG.etcName)}</option>${sites.map(x => `<option value="${x.id}" ${x.id === p.site ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      ${s.kind === 'site' ? `<button data-e="cover" ${s.cover === p.id ? 'disabled' : ''}>${s.cover === p.id ? '대표사진 ✓' : '대표사진으로'}</button>` : ''}
      ${p.type === 'video' ? '' : '<button data-e="crop">✂ 부분 잘라서 올리기</button>'}
      <button data-e="del" class="danger">삭제</button></div>`;
    const ed = k => $(`#lbEdit [data-e="${k}"]`);
    const save = async patch => {
      const { error } = await sb.from('pf_photos').update(patch).eq('id', p.id);
      if (error) { toast('실패: ' + error.message); return false; }
      Object.assign(p, patch, { site: patch.site_id !== undefined ? (patch.site_id || 'etc') : p.site });
      toast('바꿨어요'); render(); showLB(); return true;
    };
    ed('space').onchange = e => {
      let v = e.target.value;
      if (v === '__new') { v = prompt('공간 이름 (예: 드레스룸)'); if (!v || !v.trim()) return showLB(); }
      save({ space: spaceOf(v.trim()) });
    };
    ed('phase').onchange = e => save({ phase: e.target.value });
    ed('site').onchange = e => save({ site_id: e.target.value === 'etc' ? null : e.target.value });
    if (ed('cover')) ed('cover').onclick = async () => {
      const { error } = await sb.from('pf_sites').update({ cover: p.id }).eq('id', s.id);
      if (error) return toast('실패: ' + error.message);
      s.cover = p.id; toast('대표사진으로 정했어요'); render(); showLB();
    };
    if (ed('crop')) ed('crop').onclick = () => { closeLB(); cropExisting(p); };
    ed('del').onclick = async () => {
      if (!confirm('이 사진을 삭제할까요?')) return;
      const { error } = await sb.from('pf_photos').delete().eq('id', p.id);
      if (error) return toast('실패: ' + error.message);
      DATA.photos = DATA.photos.filter(x => x !== p);
      lbList = lbList.filter(x => x !== p);
      render();
      if (!lbList.length) closeLB(); else { lbI = Math.min(lbI, lbList.length - 1); showLB(); }
    };
  }

  // --- 올리기 ---
  // 진짜 JPEG/PNG인지 파일 앞부분으로 확인 (JPEG: FF D8 FF, PNG: 89 50 4E 47) — 확장자만 바꾼 다른 파일 걸러내기
  // DNG: TIFF 머리(II*\0 / MM\0*), MP4/MOV: 4~8번째 글자가 ftyp 등
  const isPhoto = async f => {
    try {
      const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
      const box = String.fromCharCode(...b.slice(4, 8));
      return (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) ||
        (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) ||
        (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0) || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0 && b[3] === 0x2A) ||
        ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box) ||
        (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46); // %PDF
    } catch { return false; }
  };
  const OK_EXT = /\.(jpe?g|png|dng|mp4|mov|m4v|pdf)$/i;
  const PHASE_RE = [
    ['before', /^(공사\s*전|시공\s*전|전|before|비포)$/i],
    ['during', /^(공사\s*중|시공\s*중|중|during|진행)$/i],
    ['after', /^(공사\s*후|시공\s*후|후|after|애프터|완공|완성)$/i],
  ];
  const phaseOf = n => (PHASE_RE.find(([, re]) => re.test(clean(n))) || [])[0];
  const up = { site: '', phase: 'after', space: '', newName: '' };
  const queue = { total: 0, done: 0, failed: [], running: 0, jobs: [] };

  function viewUpload(params) {
    if (params.get('site')) up.site = params.get('site');
    const sites = DATA.sites.filter(s => s.kind === 'site');
    if (up.site && up.site !== 'etc' && up.site !== '__new' && !siteById[up.site]) up.site = '';
    const canFolder = 'webkitdirectory' in document.createElement('input') && !matchMedia('(hover: none)').matches;
    app.innerHTML = `
      <div class="upload">
        <section class="panel">
          <h2>사진 올리기</h2>
          <label class="field"><span>1. 현장</span>
            <select id="upSite">
              <option value="">— 현장 선택 —</option>
              <option value="__new" ${up.site === '__new' ? 'selected' : ''}>＋ 새 현장 만들기</option>
              ${sites.map(s => `<option value="${s.id}" ${s.id === up.site ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
              <option value="etc" ${up.site === 'etc' ? 'selected' : ''}>${esc(CFG.etcName)} (현장명 없음 · 캡쳐)</option>
            </select>
          </label>
          <input id="upNew" placeholder="새 현장 이름 (예: 송파 헬리오시티 34평)" value="${esc(up.newName)}" ${up.site === '__new' ? '' : 'hidden'}>
          <div class="field"><span>2. 단계</span>
            <div class="seg big" id="upPhase">${PH_ORDER.map(ph => `<button type="button" data-ph="${ph}" class="${up.phase === ph ? 'on' : ''}">${PH_NAME[ph]}</button>`).join('')}</div>
          </div>
          <div class="field"><span>3. 공간</span>
            <div class="chips wrap" id="upSpace">
              ${allSpaces().map(sp => `<button type="button" class="chip ${sp === up.space ? 'on' : ''}" data-sp="${esc(sp)}">${esc(sp)}</button>`).join('')}
              <button type="button" class="chip add" data-sp="__new">＋ 직접 입력</button>
            </div>
          </div>
          <label class="pick ${ready() ? '' : 'off'}" id="pickLbl">
            <input type="file" id="upFiles" accept="image/*,video/mp4,video/quicktime,application/pdf,.pdf,.dng,.mp4,.mov" multiple hidden>
            <b>4. 사진 선택</b><small id="pickHint">${pickHint()}</small>
          </label>
          <div class="capture-row">
            ${canCapture ? '<button type="button" class="btn" id="capBtn">✂ 화면 캡쳐해서 올리기</button>' : ''}
            <label class="chk"><input type="checkbox" id="cropToggle" ${up.crop ? 'checked' : ''}> 고른 사진을 잘라서 올리기</label>
          </div>
          ${canCapture ? '<p class="help small">캡쳐 도구(Win+Shift+S)로 찍은 다음 이 화면에서 Ctrl+V 해도 바로 잘라서 올릴 수 있어요.</p>' : `
          <div class="pastebox" id="pasteBox" contenteditable="true" inputmode="none" spellcheck="false">
            <b>📋 캡쳐 붙여넣기</b>
            <small>스크린샷 → 왼쪽 아래 미리보기 → 완료 → <b>복사 후 삭제</b><br>그다음 여기를 <b>길게 눌러 「붙여넣기」</b> (사진첩에 안 남아요)</small>
          </div>`}
          <div id="dirPlan"></div>
          ${queueHTML()}
        </section>

        ${canFolder ? `<section class="panel">
          <h2>폴더 통째로 올리기 <small>노트북</small></h2>
          <p class="help">정리해 둔 폴더를 넣으면 현장·단계·공간을 폴더 이름으로 알아서 나눠요. 이미 올린 사진은 건너뛰어요.</p>
          <div class="dropzone" id="dropZone">
            <b>여기에 폴더를 끌어다 놓으세요</b>
            <small>여러 폴더를 한꺼번에 선택해서 끌어와도 돼요</small>
            <div class="adminbar" style="margin-top:4px;justify-content:center">
              <label class="btn"><input type="file" id="upDir" webkitdirectory multiple hidden>＋ 폴더 추가</label>
              <label class="btn"><input type="file" id="upLoose" multiple hidden accept="image/*,video/mp4,video/quicktime,application/pdf,.pdf,.dng,.mp4,.mov">＋ 파일 추가</label>
            </div>
            <small>폴더는 한 번에 하나씩, 여러 번 눌러서 계속 담을 수 있어요 · 낱개 파일은 위에서 고른 현장·단계·공간으로 들어가요</small>
          </div>
<pre class="tree">현장 폴더들을 모아 둔 상위 폴더 하나만 넣어도 돼요
 ├ 송파 헬리오시티\\공사전\\거실\\…
 │              \\공사후\\주방\\…
 ├ 분당 아파트\\거실\\…        ← 단계 폴더 없으면 공사후
 └ 기타작업\\거실\\…           ← 현장명 없는 사진</pre>
        </section>` : ''}

        <section class="panel">
          <div id="usage"></div>
          ${adminLinkBox()}
          <div class="adminbar" style="margin-top:12px"><button class="btn" id="logout">로그아웃</button></div>
        </section>
      </div>`;

    $('#upSite').onchange = e => { up.site = e.target.value; viewUpload(new URLSearchParams()); if (up.site === '__new') $('#upNew').focus(); };
    $('#upNew').oninput = e => { up.newName = e.target.value; refreshPick(); };
    app.querySelectorAll('[data-ph]').forEach(b => b.onclick = () => { up.phase = b.dataset.ph; app.querySelectorAll('[data-ph]').forEach(x => x.classList.toggle('on', x === b)); refreshPick(); });
    app.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => {
      let v = b.dataset.sp;
      if (v === '__new') { v = prompt('공간 이름 (예: 드레스룸, 팬트리)'); if (!v || !v.trim()) return; v = spaceOf(v.trim()); up.space = v; return viewUpload(new URLSearchParams()); }
      up.space = v; app.querySelectorAll('[data-sp]').forEach(x => x.classList.toggle('on', x === b)); refreshPick();
    });
    $('#pickLbl').onclick = e => { if (!ready()) { e.preventDefault(); toast(pickHint()); } };
    $('#upFiles').onchange = async e => {
      const files = [...e.target.files]; e.target.value = '';
      if (!files.length) return;
      if (up.crop) return cropAndUpload(files);
      // 바로 올리지 않고 아래에 미리보기로 모아 둠 → 「만들기 / 올리기」를 눌러야 올라감
      await addPicked(files.map(file => ({ file, rel: file.name })));
      const pl = $('#dirPlan'); if (pl) pl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    $('#cropToggle').onchange = e => { up.crop = e.target.checked; };
    if ($('#pasteBox')) {
      const pb = $('#pasteBox'), html = pb.innerHTML;
      pb.addEventListener('beforeinput', e => e.preventDefault()); // 글자 입력 막기
      pb.addEventListener('input', () => { pb.innerHTML = html; });
      pb.addEventListener('focus', () => { if (!ready()) { toast(pickHint()); pb.blur(); } });
    }
    if ($('#capBtn')) $('#capBtn').onclick = async () => {
      if (!ready()) return toast(pickHint());
      let blob;
      try { blob = await captureScreen(); } catch (err) { if (err && err.name !== 'NotAllowedError') toast('캡쳐를 못 했어요: ' + (err.message || err)); return; }
      cropAndUpload([new File([blob], capName(), { type: 'image/png' })], true);
    };
    if ($('#upDir')) $('#upDir').onchange = e => {
      const files = [...e.target.files]; e.target.value = '';
      addPicked(files.map(file => ({ file, rel: file.webkitRelativePath || file.name })));
    };
    if ($('#upLoose')) $('#upLoose').onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) addPicked(files.map(file => ({ file, rel: file.name }))); };
    const dz = $('#dropZone');
    if (dz) {
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = async e => {
        e.preventDefault(); dz.classList.remove('over');
        $('#dirPlan').innerHTML = '<p class="help">폴더 읽는 중…</p>';
        try { await addPicked(await readDropped(e.dataTransfer)); }
        catch (err) { $('#dirPlan').innerHTML = `<p class="err">폴더를 못 읽었어요: ${esc(err.message || err)}</p>`; }
      };
    }
    if (picked.size) planFolder([...picked].map(([rel, file]) => ({ rel, file })));
    $('#logout').onclick = () => { try { localStorage.removeItem(TOKEN); localStorage.removeItem(CACHE); } catch {} location.reload(); };
    bindLinkBox();
    loadUsage();
  }
  // --- 화면 캡쳐 / 잘라서 올리기 ---
  const canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !matchMedia('(hover: none)').matches;
  const capName = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `캡쳐_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.png`; };
  async function captureScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window' }, audio: false, selfBrowserSurface: 'exclude', preferCurrentTab: false });
    try {
      const v = document.createElement('video');
      v.srcObject = stream; v.muted = true; v.playsInline = true;
      await v.play();
      await new Promise(r => setTimeout(r, 500)); // 화면이 다 그려질 때까지 잠깐
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      return await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('캡쳐 실패')), 'image/png'));
    } finally { stream.getTracks().forEach(t => t.stop()); window.focus(); }
  }
  // 이미지에서 드래그로 영역 고르기 → 잘린 File (취소하면 null)
  function openCropper(file, opts = {}) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const el = document.createElement('div');
      el.className = 'crop';
      el.innerHTML = `<div class="crop-top"><b>${opts.title || '올릴 부분을 드래그해서 고르세요'}</b><span>${esc(opts.hint || pickHint())}</span></div>
        <div class="crop-stage"><div class="crop-wrap"><img alt="" draggable="false"><div class="crop-box" hidden></div></div></div>
        <div class="crop-bar">
          <button class="btn" data-c="cancel">${opts.multi ? '이 사진 건너뛰기' : '취소'}</button>
          <button class="btn" data-c="reset" hidden>다시 고르기</button>
          ${opts.noAll ? '' : '<button class="btn" data-c="all">전체 올리기</button>'}
          ${opts.replaceOption ? '<label class="crop-chk"><input type="checkbox" data-c="replace"> 원본은 지우고 이걸로 바꾸기</label>' : ''}
          <button class="btn primary" data-c="ok" disabled>선택한 부분 올리기</button>
        </div>`;
      document.body.appendChild(el);
      document.body.style.overflow = 'hidden';
      const img = el.querySelector('img'), wrap = el.querySelector('.crop-wrap'), box = el.querySelector('.crop-box');
      const btn = k => el.querySelector(`[data-c="${k}"]`);
      img.src = url;
      let sel = null, start = null;
      const pt = e => { const r = img.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
      const draw = () => {
        box.hidden = !sel;
        btn('ok').disabled = !sel || start; btn('reset').hidden = !sel;
        if (sel) Object.assign(box.style, { left: sel.x * 100 + '%', top: sel.y * 100 + '%', width: sel.w * 100 + '%', height: sel.h * 100 + '%' });
      };
      wrap.onpointerdown = e => { e.preventDefault(); wrap.setPointerCapture(e.pointerId); start = pt(e); sel = { x: start.x, y: start.y, w: 0, h: 0 }; draw(); };
      wrap.onpointermove = e => {
        if (!start) return;
        const p = pt(e);
        sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
        draw();
      };
      wrap.onpointerup = wrap.onpointercancel = () => {
        start = null;
        if (sel && (sel.w * img.naturalWidth < 20 || sel.h * img.naturalHeight < 20)) sel = null;
        draw();
      };
      const done = async result => {
        el.remove(); document.body.style.overflow = ''; URL.revokeObjectURL(url);
        resolve(result);
      };
      const cut = s => new Promise(res => {
        const W = img.naturalWidth, H = img.naturalHeight;
        const sx = Math.round(s.x * W), sy = Math.round(s.y * H), sw = Math.max(1, Math.round(s.w * W)), sh = Math.max(1, Math.round(s.h * H));
        const c = document.createElement('canvas'); c.width = sw; c.height = sh;
        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        c.toBlob(b => res(new File([b], file.name.replace(/\.\w+$/, '') + '_잘라냄.png', { type: 'image/png' })), 'image/png');
      });
      btn('cancel').onclick = () => done(null);
      btn('reset').onclick = () => { sel = null; draw(); };
      if (btn('all')) btn('all').onclick = () => done(file);
      btn('ok').onclick = async () => { const f = await cut(sel); if (btn('replace')) f._replace = btn('replace').checked; done(f); };
      img.onerror = () => { toast('이 사진은 열 수 없어요'); done(null); };
    });
  }
  // 올라가 있는 사진에서 부분만 잘라서 → 새 사진으로 추가 (원하면 원본과 바꾸기)
  async function cropExisting(p) {
    if (!p) return;
    toast('사진 불러오는 중…', 1500);
    let blob;
    try { const r = await fetch(imgUrl(p.l)); if (!r.ok) throw 0; blob = await r.blob(); } catch { return toast('사진을 불러오지 못했어요'); }
    const s = siteById[p.site];
    const file = new File([blob], (p.src_name || '사진').replace(/.w+$/, '') + '.jpg', { type: blob.type || 'image/jpeg' });
    const out = await openCropper(file, { title: '남길 부분을 드래그해서 고르세요', noAll: true, replaceOption: true,
      hint: `${s ? s.name : ''} · ${p.phase !== 'after' ? PH_NAME[p.phase] : spLabel(p.space)} 에 올라가요` });
    if (!out) return;
    toast('올리는 중…', 1500);
    try {
      await uploadOne({ file: out, siteId: p.site_id ?? null, phase: p.phase, space: p.space });
      if (out._replace) { await api('DELETE', `/photos/${p.id}`); DATA.photos = DATA.photos.filter(x => x.id !== p.id); }
      toast(out._replace ? '잘라낸 사진으로 바꿨어요' : '잘라낸 사진을 추가했어요');
    } catch (e) { toast('올리기 실패: ' + (e.message || e)); }
    usage = null; scheduleReload();
  }
  async function cropAndUpload(files, isCapture) {
    if (!ready()) return toast(pickHint());
    const siteId = await resolveSite();
    if (siteId === undefined) return;
    const target = { siteId, phase: up.phase, space: up.space };
    files = await expandPdfs(files);
    for (let i = 0; i < files.length; i++) {
      let src = files[i];
      if (isVideoFile(src)) { enqueue([{ file: src, ...target }]); continue; } // 동영상은 자르지 않고 그대로
      if (isDng(src)) {
        try { const img = await dngPreview(src); const j = await toJpeg(img, 4000, 0.92); src = new File([j.blob], src.name.replace(/\.dng$/i, '.jpg'), { type: 'image/jpeg' }); }
        catch (e) { toast(src.name + ': ' + e.message); continue; }
      }
      const f = await openCropper(src, {
        multi: files.length > 1,
        title: isCapture ? '캡쳐한 화면에서 올릴 부분을 드래그하세요' : files.length > 1 ? `${i + 1} / ${files.length} — 올릴 부분을 드래그하세요` : '',
      });
      if (f) enqueue([{ file: f, ...target }]);
    }
  }
  // 캡쳐 도구로 찍은 걸 Ctrl+V 하면 바로 자르기 화면
  document.addEventListener('paste', e => {
    if (!ADMIN || !location.hash.startsWith('#/upload') || /INPUT|TEXTAREA/.test(e.target.tagName) || document.querySelector('.crop')) return;
    const inBox = e.target.closest && e.target.closest('#pasteBox');
    const item = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (inBox) e.preventDefault();
    if (!item) { if (inBox) toast('복사된 사진이 없어요. 스크린샷에서 「복사 후 삭제」를 먼저 눌러주세요.', 4000); return; }
    e.preventDefault();
    if (inBox) e.target.closest('#pasteBox').blur();
    const blob = item.getAsFile();
    cropAndUpload([new File([blob], capName(), { type: blob.type || 'image/png' })], true);
  });

  function ready() { return up.site && (up.site !== '__new' || up.newName.trim()) && up.space; }
  function pickHint() {
    if (!up.site) return '먼저 현장을 고르세요';
    if (up.site === '__new' && !up.newName.trim()) return '새 현장 이름을 적어주세요';
    if (!up.space) return '공간을 고르세요';
    const n = up.site === '__new' ? up.newName.trim() : siteById[up.site]?.name || CFG.etcName;
    return `${n} · ${PH_NAME[up.phase]} · ${up.space} 에 올라가요`;
  }
  function refreshPick() {
    const l = $('#pickLbl'); if (!l) return; l.classList.toggle('off', !ready()); $('#pickHint').textContent = pickHint();
    // 담아 둔 낱개 파일이 있으면 바뀐 현장·단계·공간으로 다시 정리
    if ([...picked.keys()].some(r => !r.includes('/'))) planFolder([...picked].map(([rel, file]) => ({ rel, file })));
  }
  async function resolveSite() {
    if (up.site === 'etc') return null;
    if (up.site !== '__new') return up.site;
    const name = up.newName.trim();
    const exist = DATA.sites.find(s => s.kind === 'site' && s.name === name);
    if (exist) { up.site = exist.id; return exist.id; }
    const { data, error } = await sb.from('pf_sites').insert({ name }).select().single();
    if (error) { toast('현장 만들기 실패: ' + error.message); return undefined; }
    DATA.sites.unshift({ ...data, kind: 'site', info: {} }); siteById[data.id] = DATA.sites[0];
    up.site = data.id; up.newName = '';
    return data.id;
  }

  function queueHTML() {
    if (!queue.total) return '<div id="queue"></div>';
    const doneAll = queue.done + queue.failed.length >= queue.total;
    return `<div id="queue" class="queue">${doneAll ? `✓ ${queue.done}장 올렸어요` : `올리는 중… ${queue.done}/${queue.total}`}
      ${queue.failed.length ? `<div class="err">못 올린 사진 ${queue.failed.length}장: ${queue.failed.slice(0, 5).map(esc).join(', ')}${queue.failed.length > 5 ? ' …' : ''}<br><small>아이폰 HEIC 사진은 노트북 크롬에서 안 열릴 수 있어요 → 아이폰/아이패드에서 올리면 돼요</small></div>` : ''}</div>`;
  }
  function updateQueueUI() {
    const doneAll = queue.done + queue.failed.length >= queue.total;
    const bar = $('#upbar');
    bar.hidden = !queue.total || doneAll;
    $('#upText').textContent = `사진 올리는 중 ${queue.done + queue.failed.length}/${queue.total}`;
    $('#upFill').style.width = (queue.total ? (queue.done + queue.failed.length) / queue.total * 100 : 0) + '%';
    const q = $('#queue'); if (q) q.outerHTML = queueHTML();
  }
  // PDF 파일 → 쪽마다 JPEG 사진 파일로 (일반 사진 올리기·폴더 올리기·자르기에서 공통)
  const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  async function pdfToFiles(f, say) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    const out = [], base = f.name.replace(/\.pdf$/i, '');
    for (let i = 1; i <= doc.numPages; i++) {
      if (say) say(`PDF를 사진으로 바꾸는 중… ${f.name} ${i} / ${doc.numPages}쪽`);
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(4, 2000 / Math.max(v1.width, v1.height)) });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp, canvas: c, intent: 'print' }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
      out.push(new File([blob], `${base} ${i}쪽.jpg`, { type: 'image/jpeg' }));
      page.cleanup();
    }
    try { if (typeof doc.destroy === 'function') await doc.destroy(); } catch {}
    return out;
  }
  async function expandPdfs(files) {
    if (!files.some(isPdf)) return files;
    const out = [];
    for (const f of files) {
      if (!isPdf(f)) { out.push(f); continue; }
      try { out.push(...await pdfToFiles(f, t => toast(t, 4000))); }
      catch (e) { toast(f.name + ': PDF를 열 수 없어요', 4000); }
    }
    return out;
  }
  async function enqueue(jobs) {
    if (jobs.some(j => isPdf(j.file))) {
      const out = [];
      for (const j of jobs) {
        if (!isPdf(j.file)) { out.push(j); continue; }
        for (const file of await expandPdfs([j.file])) out.push({ ...j, file });
      }
      jobs = out;
      if (!jobs.length) return;
    }
    try {
      if (!usage) { const r = await fetch(`${CFG.API_URL}/usage`, { headers: await authHeader() }); if (r.ok) usage = await r.json(); }
      const need = jobs.reduce((n, j) => n + (isVideoFile(j.file) ? j.file.size : 700000), 0);
      if (usage && usage.bytes + need > usage.limit) return toast("저장공간(10GB)이 꽉 차서 더 올릴 수 없어요. 안 쓰는 사진을 지워주세요.", 5000);
    } catch {}
    if (queue.done + queue.failed.length >= queue.total) { queue.total = 0; queue.done = 0; queue.failed = []; }
    queue.total += jobs.length; queue.jobs.push(...jobs);
    updateQueueUI();
    while (queue.running < 3 && queue.jobs.length) worker();
  }
  async function worker() {
    queue.running++;
    while (queue.jobs.length) {
      const j = queue.jobs.shift();
      try { await uploadOne(j); queue.done++; }
      catch (e) { console.warn(e); queue.failed.push(j.file.name + (e && e.message && /동영상|DNG/.test(e.message) ? ` (${e.message})` : '')); }
      updateQueueUI();
    }
    queue.running--;
    if (!queue.running) { scheduleReload(); usage = null; loadUsage(); if (queue.done) toast(`${queue.done}장 올렸어요`); }
  }
  window.addEventListener('beforeunload', e => { if (queue.running) { e.preventDefault(); e.returnValue = ''; } });

  const MAX_VIDEO = 95 * 1024 * 1024;
  const isVideoFile = f => /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name);
  const isDng = f => /\.dng$/i.test(f.name) || /dng/i.test(f.type);
  async function loadImg(blob) {
    const url = URL.createObjectURL(blob);
    // decode()는 다른 탭으로 넘어가 있으면 멈출 수 있어서 onload로 기다림
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('이미지를 열 수 없음')); img.src = url; });
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  }
  // DNG(RAW): 브라우저가 직접 못 열면 파일 안에 들어 있는 미리보기 JPEG 중 가장 큰 것을 꺼내 씀
  async function dngPreview(file) {
    try { return await loadImg(file); } catch {}
    const buf = new Uint8Array(await file.arrayBuffer());
    const found = [];
    for (let i = 0; i < buf.length - 3; i++) {
      if (buf[i] !== 0xFF || buf[i + 1] !== 0xD8 || buf[i + 2] !== 0xFF) continue;
      for (let j = i + 3; j < buf.length - 1; j++) if (buf[j] === 0xFF && buf[j + 1] === 0xD9) { found.push([i, j + 2]); break; }
    }
    found.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    for (const [a, b] of found.slice(0, 4)) {
      if (b - a < 20000) break; // 아주 작은 썸네일은 건너뜀
      try { return await loadImg(new Blob([buf.subarray(a, b)], { type: 'image/jpeg' })); } catch {}
    }
    throw new Error('DNG 안에서 사진을 찾지 못했어요');
  }
  // 동영상에서 첫 장면을 잡아 목록용 그림으로
  function videoPoster(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      const fail = () => { URL.revokeObjectURL(url); rej(new Error('이 동영상은 열 수 없어요 (MP4/H.264 권장)')); };
      v.onerror = fail;
      v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); };
      v.onseeked = () => {
        const W = v.videoWidth, H = v.videoHeight; if (!W) return fail();
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        c.getContext('2d').drawImage(v, 0, 0, W, H);
        URL.revokeObjectURL(url); res(c);
      };
      setTimeout(() => { if (!v.videoWidth) fail(); }, 20000);
    });
  }
  async function uploadOne({ file, siteId, phase, space }) {
    const id = crypto.randomUUID();
    if (isVideoFile(file)) {
      if (file.size > MAX_VIDEO) throw new Error(`동영상이 너무 커요 (${Math.round(file.size / 1048576)}MB, 최대 95MB)`);
      const poster = await videoPoster(file);
      const thumb = await toJpeg(poster, 900, 0.8);
      const t = `ph/${id}_t.jpg`, l = `ph/${id}_v.mp4`;
      await putFile(t, thumb.blob);
      try { await putFile(l, file, 'video/mp4'); } catch (e) { await deleteKeys([t]); throw e; }
      const ins = await sb.from('pf_photos').insert({ id, type: 'video', site_id: siteId, phase, space, t, l, w: thumb.w, h: thumb.h, src_name: file.name, src_size: file.size });
      if (ins.error) { await deleteKeys([t, l]); throw ins.error; }
      usage = null; return;
    }
    let img;
    try { img = isDng(file) ? await dngPreview(file) : await loadImg(file); }
    catch (e) { throw new Error(e.message || '이미지를 열 수 없음'); }
    const large = await toJpeg(img, 2000, 0.85), thumb = await toJpeg(img, 900, 0.8);
    const t = `ph/${id}_t.jpg`, l = `ph/${id}_l.jpg`;
    await putFile(t, thumb.blob);
    try { await putFile(l, large.blob); } catch (e) { await deleteKeys([t]); throw e; }
    const ins = await sb.from('pf_photos').insert({ id, site_id: siteId, phase, space, t, l, w: thumb.w, h: thumb.h, src_name: file.name, src_size: file.size });
    if (ins.error) { await deleteKeys([t, l]); throw ins.error; }
    usage = null;
  }
  // --- 사진 저장소 (Cloudflare R2 Worker) ---
  async function authHeader() { return { Authorization: 'Bearer ' + getToken() }; }
  async function putFile(key, blob, type = 'image/jpeg') {
    const r = await fetch(`${CFG.API_URL}/p/${key}`, { method: 'PUT', headers: { ...(await authHeader()), 'Content-Type': type }, body: blob });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '업로드 실패 ' + r.status);
  }
  async function deleteKeys(keys) {
    if (!keys.length) return;
    await fetch(`${CFG.API_URL}/delete`, { method: 'POST', headers: { ...(await authHeader()), 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) }).catch(() => {});
    usage = null;
  }
  let usage = null;
  async function loadUsage() {
    const el = $('#usage'); if (!el) return;
    try {
      if (!usage) { const r = await fetch(`${CFG.API_URL}/usage`, { headers: await authHeader() }); if (!r.ok) throw 0; usage = await r.json(); }
      const pct = Math.min(100, usage.bytes / usage.limit * 100);
      const fmt = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + 'GB' : Math.round(b / 1048576) + 'MB';
      el.innerHTML = `<div class="usage ${pct >= 80 ? 'warn' : ''}"><div><b>저장공간</b><span>${fmt(usage.bytes)} / ${fmt(usage.limit)} · 사진 ${Math.round(usage.count / 2)}장</span></div>
        <i><b style="width:${pct.toFixed(1)}%"></b></i>${pct >= 80 ? '<p class="err">저장공간이 거의 찼어요. 안 쓰는 사진을 정리해 주세요.</p>' : ''}</div>`;
    } catch { el.innerHTML = '<div class="usage"><span>저장공간 정보를 못 불러왔어요</span></div>'; }
  }
  function toJpeg(img, max, q) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height, s = Math.min(1, max / Math.max(W, H));
    const w = Math.round(W * s), h = Math.round(H * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
    return new Promise((res, rej) => c.toBlob(b => b ? res({ blob: b, w, h }) : rej(new Error('변환 실패')), 'image/jpeg', q));
  }

  // --- 폴더 통째로 ---
  let plan = null;
  // 고른 폴더들을 모아 두는 곳 (폴더 추가 / 끌어다 놓기 여러 번 가능)
  const picked = new Map(); // 경로 → File
  async function addPicked(entries) {
    for (const { file, rel } of entries) picked.set(rel, file);
    await planFolder([...picked].map(([rel, file]) => ({ rel, file })));
  }
  // 끌어다 놓은 폴더 안의 파일을 전부 꺼내기
  async function readDropped(dt) {
    const out = [];
    const walk = async (entry, path) => {
      if (entry.isFile) { const file = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file, rel: path + entry.name }); return; }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, path + entry.name + '/');
      }
    };
    const entries = [...dt.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    for (const e of entries) await walk(e, '');
    return out;
  }
  function looseTarget() {
    let site = null;
    if (up.site === '__new' && up.newName.trim()) site = up.newName.trim();
    else if (up.site && up.site !== 'etc' && up.site !== '__new' && siteById[up.site]) site = siteById[up.site].name;
    const chosen = up.site && (up.site !== '__new' || up.newName.trim());
    return { site, phase: chosen ? up.phase : 'after', space: chosen && up.phase === 'after' && up.space ? up.space : '미분류' };
  }
  // 미리보기용 작은 사진 주소 (파일마다 한 번만 만들고, 비우거나 올리면 정리)
  const thumbUrls = new Map();
  const thumbOf = f => { if (!/\.(jpe?g|png)$/i.test(f.name)) return null; if (!thumbUrls.has(f)) thumbUrls.set(f, URL.createObjectURL(f)); return thumbUrls.get(f); };
  const clearThumbs = () => { for (const u of thumbUrls.values()) URL.revokeObjectURL(u); thumbUrls.clear(); };
  const isSpaceName = n => { const s = spaceOf(n); return CFG.spaceOrder.includes(s) || Object.values(CFG.spaceAlias).includes(s); };
  async function planFolder(list) {
    const isRoot = n => ['현장', '기타작업'].includes(clean(n));
    // 맨 위 폴더마다 어떤 종류인지 판단
    //  - 현장/기타작업 폴더를 품은 "사진" 폴더  → photoRoot
    //  - 바로 아래가 공사전·후 또는 거실·주방 같은 공간 → 현장 폴더 하나
    //  - 그 밖 (현장 폴더들을 모아 둔 상위 폴더) → 안의 폴더 하나하나가 현장
    const kind = {};
    const byRoot = {};
    for (const it of list) { const ps = it.rel.split('/'); if (ps.length > 1) (byRoot[ps[0]] = byRoot[ps[0]] || new Set()).add(ps.length > 2 ? ps[1] : ''); }
    for (const [root, subs] of Object.entries(byRoot)) {
      const dirs = [...subs].filter(Boolean);
      if (isRoot(root)) kind[root] = 'named';
      else if (dirs.some(isRoot)) kind[root] = 'photoRoot';
      else if (!dirs.length || dirs.some(d => phaseOf(d) || isSpaceName(d))) kind[root] = 'site';
      else kind[root] = 'container';
    }
    const items = [], infos = {}, skipped = [];
    for (const { file: f, rel } of list) {
      const ps = rel.split('/'), name = ps[ps.length - 1];
      let rest = ps.slice(1, -1), root = clean(ps[0]), site;
      const k = kind[ps[0]];
      if (ps.length === 1) { root = '기타작업'; } // 낱개 파일
      else if (k === 'photoRoot') { if (rest.length && isRoot(rest[0])) { root = clean(rest[0]); rest = rest.slice(1); } else root = '기타작업'; }
      else if (k === 'container') { if (rest.length) { root = '현장'; } else root = '기타작업'; }
      if (root === '현장') { if (rest.length) { site = clean(rest[0]); rest = rest.slice(1); } else site = null; }
      else if (root === '기타작업') site = null;
      else site = clean(ps[0]);
      if (/^(정보|info)\.txt$/i.test(name) && site && !rest.length) { infos[site] = await f.text(); continue; }
      if (name.startsWith('.') || name.startsWith('~')) continue;
      if (!OK_EXT.test(name) || !(await isPhoto(f))) { if (!/\.(txt|ini|db|ds_store)$/i.test(name)) skipped.push(rel); continue; }
      // 낱개 파일: 위에서 고른 현장·단계·공간으로 (안 골랐으면 기타 작업물 · 미분류)
      if (ps.length === 1) { const tg = looseTarget(); items.push({ file: f, rel, siteName: tg.site, phase: tg.phase, space: tg.space }); continue; }
      let phase = 'after';
      if (site && rest.length && phaseOf(rest[0])) { phase = phaseOf(rest[0]); rest = rest.slice(1); }
      items.push({ file: f, rel, siteName: site, phase, space: rest.length && isSpaceName(rest[0]) ? spaceOf(rest[0]) : '미분류' }); // 거실·주방 같은 진짜 공간 이름만, 나머지는 미분류
    }
    // 이미 올린 사진 건너뛰기
    const nameToId = Object.fromEntries(DATA.sites.filter(s => s.kind === 'site').map(s => [s.name, s.id]));
    const have = new Set(DATA.photos.map(p => `${p.site}|${p.src_name}|${p.src_size}`));
    const todo = items.filter(it => !have.has(`${it.siteName === null ? 'etc' : nameToId[it.siteName] || '?'}|${it.file.name}|${it.file.size}`));
    const groups = {};
    for (const it of todo) { const k = it.siteName ?? '\u0000'; (groups[k] = groups[k] || []).push(it); }
    plan = { todo, infos, groups };
    const newSites = Object.keys(groups).filter(k => k !== '\u0000' && !nameToId[k]);
    const roots = Object.keys(byRoot), nLoose = list.filter(it => !it.rel.includes('/')).length;
    $('#dirPlan').innerHTML = `<div class="planbox">
      <div class="picked-row"><span>${roots.length ? `담은 폴더 ${roots.length}개: ${roots.slice(0, 6).map(esc).join(', ')}${roots.length > 6 ? ' …' : ''}` : ''}${roots.length && nLoose ? ' · ' : ''}${nLoose ? `낱개 파일 ${nLoose}개` : ''}</span><button class="btn small" id="dirClear" type="button">비우기</button></div>
      <b>새로 올릴 사진 ${todo.length}장</b>${items.length - todo.length ? ` <small>(이미 올린 ${items.length - todo.length}장 건너뜀)</small>` : ''}
      <ul>${Object.entries(groups).map(([k, arr]) => {
        const by = countBy(arr, 'phase');
        return `<li><b>${k === '\u0000' ? esc(CFG.etcName) : esc(k)}</b>${k !== '\u0000' && !nameToId[k] ? ' <span class="tag">새 현장</span>' : ''}
          <small>${PH_ORDER.filter(ph => by[ph]).map(ph => `${PH_NAME[ph]} ${by[ph]}`).join(' · ')} — ${sortSpaces(arr.map(i => i.space)).join(', ')}</small>
          <div class="pv-grid">${arr.slice(0, 60).map(it => {
            const u = thumbOf(it.file), ext = (it.file.name.match(/\.(\w+)$/) || [, ''])[1].toUpperCase();
            return `<div class="pv" title="${esc(it.rel)}">${u ? `<img src="${u}" loading="lazy" alt="">` : `<span class="pv-ext">${esc(ext)}</span>`}<button type="button" class="pv-x" data-rm="${esc(it.rel)}" aria-label="빼기">×</button><small>${esc(it.phase === 'after' ? it.space : PH_NAME[it.phase])}</small></div>`;
          }).join('')}${arr.length > 60 ? `<div class="pv more">+${arr.length - 60}장</div>` : ''}</div></li>`;
      }).join('')}</ul>
      ${skipped.length ? `<p class="err">JPG·PNG·DNG·PDF·MP4가 아닌 파일 ${skipped.length}개는 안 올려요</p>` : ''}
      ${todo.length ? `<button class="btn primary" id="dirGo">${newSites.length ? `만들기 — 새 현장 ${newSites.length}곳 · ${todo.length}장 올리기` : `${todo.length}장 올리기`}</button>` : ''}</div>`;
    if ($('#dirGo')) $('#dirGo').onclick = runFolder;
    $('#dirClear').onclick = () => { picked.clear(); clearThumbs(); plan = null; $('#dirPlan').innerHTML = ''; };
    $('#dirPlan').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { picked.delete(b.dataset.rm); if (!picked.size) { clearThumbs(); plan = null; $('#dirPlan').innerHTML = ''; return; } planFolder([...picked].map(([rel, file]) => ({ rel, file }))); });
  }
  const parseInfo = txt => {
    const info = {}, desc = [];
    for (const line of txt.replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([^:：]{1,10})\s*[:：]\s*(.*)$/);
      if (m && m[1].trim() !== '설명') info[m[1].trim()] = m[2].trim();
      else if (m) desc.push(m[2]); else if (line.trim()) desc.push(line.trim());
    }
    if (desc.length) info['설명'] = desc.join('\n');
    return info;
  };
  async function runFolder() {
    $('#dirGo').disabled = true;
    const jobs = [];
    for (const [k, arr] of Object.entries(plan.groups)) {
      let siteId = null;
      if (k !== '\u0000') {
        const exist = DATA.sites.find(s => s.kind === 'site' && s.name === k);
        const info = plan.infos[k] ? parseInfo(plan.infos[k]) : null;
        if (exist) {
          siteId = exist.id;
          if (info && !Object.keys(exist.info).length) await sb.from('pf_sites').update({ info }).eq('id', siteId);
        } else {
          const { data, error } = await sb.from('pf_sites').insert({ name: k, info: info || {} }).select().single();
          if (error) { toast('현장 만들기 실패: ' + error.message); continue; }
          siteId = data.id; DATA.sites.unshift({ ...data, kind: 'site' }); siteById[data.id] = DATA.sites[0];
          if (up.site === '__new' && up.newName.trim() === k) { up.site = data.id; up.newName = ''; }
        }
      }
      for (const it of arr) jobs.push({ file: it.file, siteId, phase: it.phase, space: it.space });
    }
    picked.clear(); plan = null; setTimeout(clearThumbs, 60000);
    $('#dirPlan').innerHTML = '';
    enqueue(jobs);
  }

  async function afterLogin() {
    app.innerHTML = '<p class="none">불러오는 중…</p>';
    try { await fetchAll(); }
    catch (e) { app.innerHTML = `<div class="empty"><h2>서버 연결 문제</h2><p>${esc(e.message)}</p><p>인터넷 연결을 확인하고 다시 열어보세요.</p></div>`; return; }
    subscribe();
    render();
  }

  // ---------- 라우터 ----------
  function render() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const h = decodeURIComponent(path);
    const route = h.split('/')[0], arg = h.split('/').slice(1).join('/');
    const tab = route === 'sites' || route === 'site' ? 'sites' : route === 'upload' ? 'upload' : 'space';
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
    if (ADMIN && route !== 'site') { const b = $('#selBar'); if (b) b.remove(); app.classList.remove('sel-mode'); }
    if (ADMIN && !session) return viewLogin();
    if (!loaded) return;
    if (route === 'upload' && ADMIN) return viewUpload(new URLSearchParams(qs || ''));
    if (!ADMIN) {
      // 고객 링크는 현장별로만 보기
      if (!DATA.photos.length) return app.innerHTML = '<p class="none">준비 중이에요.</p>';
      return route === 'site' ? viewSite(arg) : viewSites();
    }
    if (!DATA.photos.length && route !== 'site' && route !== 'sites')
      return app.innerHTML = `<div class="empty"><h2>아직 사진이 없어요</h2><p>위의 <b>＋ 올리기</b>에서 사진을 올려보세요. 노트북·아이폰·아이패드 어디서 올려도 바로 반영돼요.</p><a class="btn primary" href="#/upload">사진 올리러 가기</a></div>`;
    if (route === 'sites') viewSites();
    else if (route === 'site') viewSite(arg);
    else viewSpaces(route === 'space' ? arg : null);
  }
  let lastRoute = location.hash.split('/')[1] || '';
  window.addEventListener('hashchange', () => {
    closeLB();
    const r = (location.hash.split('/')[1] || '').split('?')[0];
    if (r !== lastRoute || r === 'site') window.scrollTo(0, 0);
    lastRoute = r;
    render();
  });

  // ---------- 시작 ----------
  (async () => {
    if (ADMIN) {
      session = getToken();
      if (!session) return render();
      if (loaded) render();
      return afterLogin();
    }
    if (loaded) render();
    try { await fetchAll(); render(); subscribe(); }
    catch (e) { console.warn(e); if (!loaded) app.innerHTML = '<p class="none">잠시 후 다시 열어주세요.</p>'; }
  })();
})();
