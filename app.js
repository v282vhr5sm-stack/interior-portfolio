(() => {
  const CFG = window.SITE_CONFIG;
  const ADMIN = !!window.PF_ADMIN;
  const BUCKET = 'portfolio';
  const PH_NAME = { before: '공사전', during: '공사중', after: '공사후' };
  const PH_ORDER = ['before', 'during', 'after'];
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const imgUrl = p => `${CFG.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p}`;
  const clean = n => String(n).replace(/^\d+\s*[._\-)]\s*/, '').trim() || String(n);
  const spaceOf = n => { const c = clean(n); return CFG.spaceAlias[c] || c; };

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, ADMIN
    ? { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pf-admin-auth' } }
    : { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'pf-public' } });

  document.title = ADMIN ? '포트폴리오 관리' : CFG.name;
  $('#brandName').textContent = CFG.name;
  if ($('#brandTag')) $('#brandTag').textContent = CFG.tagline || '';
  if ($('#contact')) $('#contact').textContent = CFG.contact || '';

  // ---------- 데이터 ----------
  let DATA = { sites: [], photos: [] }, siteById = {}, session = null, loaded = false;
  const CACHE = 'pf-cache-' + (ADMIN ? 'admin' : 'public');
  function setData(sites, photos) {
    const list = sites.map(s => ({ ...s, kind: 'site', info: s.info || {} }));
    const etc = { id: 'etc', name: CFG.etcName, kind: 'etc', info: {}, hidden: false };
    photos = photos.map(p => ({ ...p, site: p.site_id || 'etc' }));
    if (photos.some(p => p.site === 'etc')) list.push(etc);
    siteById = Object.fromEntries(list.map(s => [s.id, s]));
    photos = photos.filter(p => siteById[p.site]);
    DATA = { sites: list, photos };
  }
  try { const c = JSON.parse(localStorage.getItem(CACHE)); if (c) { setData(c.sites, c.photos); loaded = true; } } catch {}

  async function fetchAll() {
    const s = await sb.from('pf_sites').select('*').order('sort', { ascending: false });
    if (s.error) throw s.error;
    const photos = [];
    for (let from = 0; ; from += 1000) {
      const r = await sb.from('pf_photos').select('id,site_id,phase,space,t,l,w,h,src_name,src_size,created_at').order('created_at').range(from, from + 999);
      if (r.error) throw r.error;
      photos.push(...r.data);
      if (r.data.length < 1000) break;
    }
    setData(s.data, photos);
    loaded = true;
    try { localStorage.setItem(CACHE, JSON.stringify({ sites: s.data, photos })); } catch {}
  }
  let reloadTimer = null, pendingReload = false;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (!$('#lb').hidden) { pendingReload = true; return; }
      try { await fetchAll(); render(); } catch (e) { console.warn(e); }
    }, 700);
  }
  function subscribe() {
    sb.channel('pf-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pf_photos' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pf_sites' }, scheduleReload)
      .subscribe();
    // 탭/앱으로 돌아올 때도 새로고침 (실시간 연결이 끊겼을 때 대비)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleReload(); });
  }

  // ---------- 공통 ----------
  const spaceRank = s => { const i = CFG.spaceOrder.indexOf(s); return i < 0 ? (s === '기타' ? 999 : 500) : i; };
  const sortSpaces = arr => [...new Set(arr)].sort((a, b) => spaceRank(a) - spaceRank(b) || a.localeCompare(b, 'ko'));
  const countBy = (arr, k) => arr.reduce((m, p) => (m[p[k]] = (m[p[k]] || 0) + 1, m), {});
  const allSpaces = () => sortSpaces([...CFG.spaceOrder, ...DATA.photos.map(p => p.space)]);
  const state = { phase: CFG.defaultPhase === 'all' ? 'all' : 'after' };

  const photoHTML = (p, idx, opts = {}) => {
    const s = siteById[p.site];
    const ratio = p.w && p.h && !opts.strip ? ` style="aspect-ratio:${p.w}/${p.h}"` : '';
    const badge = p.phase !== 'after' && !opts.noBadge ? `<span class="badge ${p.phase}">${PH_NAME[p.phase]}</span>` : '';
    const cover = ADMIN && s.cover === p.id ? '<span class="badge cover">대표</span>' : '';
    return `<figure class="ph" data-i="${idx}"${ratio}>${badge}${cover}
      <img src="${imgUrl(p.t)}" loading="lazy" alt="" draggable="false">
      ${opts.noCap ? '' : `<figcaption class="cap">${esc(p.space)} · ${esc(s.name)}</figcaption>`}</figure>`;
  };
  const coverOf = id => {
    const ps = DATA.photos.filter(p => p.site === id), s = siteById[id];
    return ps.find(p => p.id === s.cover) || ps.find(p => p.phase === 'after' && p.space === '거실') || ps.find(p => p.phase === 'after') || ps[0];
  };

  // ---------- 공간별 ----------
  function viewSpaces(space) {
    let pool = DATA.photos;
    const phaseCount = countBy(pool, 'phase');
    if (state.phase !== 'all') pool = pool.filter(p => p.phase === state.phase);
    const spaces = sortSpaces(pool.map(p => p.space));
    if (space && !spaces.includes(space)) space = null;
    const counts = countBy(pool, 'space');
    const list = space ? pool.filter(p => p.space === space) : pool.slice();
    const siteIdx = Object.fromEntries(DATA.sites.map((s, i) => [s.id, i]));
    list.sort((a, b) => siteIdx[a.site] - siteIdx[b.site] || PH_ORDER.indexOf(a.phase) - PH_ORDER.indexOf(b.phase));

    const segBtn = (k, label) => `<button data-phase="${k}" class="${state.phase === k ? 'on' : ''}" ${k !== 'all' && !phaseCount[k] ? 'disabled' : ''}>${label}</button>`;
    app.innerHTML = `
      <div class="filters">
        <div class="chips">
          <a class="chip ${space ? '' : 'on'}" href="#/">전체<b>${pool.length}</b></a>
          ${spaces.map(s => `<a class="chip ${s === space ? 'on' : ''}" href="#/space/${encodeURIComponent(s)}">${esc(s)}<b>${counts[s]}</b></a>`).join('')}
        </div>
        <div class="phase-row">
          <div class="seg">${segBtn('after', '공사후')}${segBtn('during', '공사중')}${segBtn('before', '공사전')}${segBtn('all', '전체')}</div>
          <span class="count">${list.length}장</span>
        </div>
      </div>
      ${list.length ? `<div class="grid">${list.map((p, i) => photoHTML(p, i)).join('')}</div>` : `<p class="none">이 조건에 맞는 사진이 없어요.</p>`}`;
    app.querySelectorAll('[data-phase]').forEach(b => b.onclick = () => { state.phase = b.dataset.phase; render(); });
    bindPhotos(list);
  }

  // ---------- 현장별 ----------
  function viewSites() {
    const card = s => {
      const ps = DATA.photos.filter(p => p.site === s.id);
      const c = coverOf(s.id);
      const phases = PH_ORDER.filter(ph => ps.some(p => p.phase === ph));
      const meta = [s.info['위치'], s.info['평수'], s.info['연도']].filter(Boolean).join(' · ');
      return `<a class="card ${s.kind}" href="#/site/${s.id}">
        <div class="cover">${c ? `<img src="${imgUrl(c.t)}" loading="lazy" alt="" draggable="false">` : '<span class="nophoto">사진 없음</span>'}
          ${ADMIN && s.hidden ? '<span class="badge hid">고객에게 숨김</span>' : ''}</div>
        <div class="body">
          <h3>${esc(s.name)}</h3>
          <div class="meta">${esc(meta || `사진 ${ps.length}장`)}</div>
          <div class="tags">
            ${phases.length > 1 ? phases.map(ph => `<span class="tag">${PH_NAME[ph]}</span>`).join('') : ''}
            ${sortSpaces(ps.map(p => p.space)).slice(0, 5).map(sp => `<span class="tag">${esc(sp)}</span>`).join('')}
          </div>
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
    const ps = DATA.photos.filter(p => p.site === id);
    const spaces = sortSpaces(ps.map(p => p.space));
    const ordered = [];
    const blocks = spaces.map(sp => {
      const inSpace = ps.filter(p => p.space === sp);
      const phases = PH_ORDER.filter(ph => inSpace.some(p => p.phase === ph));
      const rows = phases.map(ph => {
        const html = inSpace.filter(p => p.phase === ph).map(p => photoHTML(p, ordered.push(p) - 1, { strip: true, noBadge: true, noCap: true })).join('');
        return phases.length > 1 || (s.kind === 'site' && ph !== 'after')
          ? `<div class="phase-block"><div class="lbl"><span class="badge ${ph}">${PH_NAME[ph]}</span></div><div class="strip">${html}</div></div>`
          : `<div class="strip">${html}</div>`;
      }).join('');
      return `<section class="space-sec" id="sp-${encodeURIComponent(sp)}"><h2>${esc(sp)} <small>${inSpace.length}장</small></h2>${rows}</section>`;
    }).join('');
    const c = coverOf(id);
    const info = Object.entries(s.info).filter(([k, v]) => k !== '설명' && v);
    const pc = countBy(ps, 'phase');
    app.innerHTML = `
      <a class="back" href="#/sites">← 현장 목록</a>
      <div class="site-head">
        <div class="hero" id="hero">${c ? `<img src="${imgUrl(c.l)}" alt="" draggable="false">` : ''}</div>
        <div>
          <h1>${esc(s.name)} ${ADMIN && s.hidden ? '<span class="badge hid">고객에게 숨김</span>' : ''}</h1>
          ${info.length ? `<dl class="info">${info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
          ${s.info['설명'] ? `<p class="desc">${esc(s.info['설명'])}</p>` : ''}
          <div class="phase-sum">${PH_ORDER.filter(ph => pc[ph]).map(ph => `<span class="badge ${ph}">${PH_NAME[ph]} ${pc[ph]}</span>`).join('')}</div>
          ${ADMIN ? siteAdminBar(s) : ''}
        </div>
      </div>
      ${ADMIN ? '<div id="siteEdit"></div>' : ''}
      ${spaces.length ? `<div class="filters"><div class="chips">
        ${spaces.map(sp => `<button class="chip" data-jump="${esc(sp)}">${esc(sp)}<b>${ps.filter(p => p.space === sp).length}</b></button>`).join('')}
      </div></div>` : '<p class="none">아직 사진이 없어요.</p>'}
      ${blocks}`;
    app.querySelectorAll('[data-jump]').forEach(b => b.onclick = () =>
      document.getElementById('sp-' + encodeURIComponent(b.dataset.jump)).scrollIntoView({ behavior: 'smooth' }));
    if (c) $('#hero').onclick = () => openLB(ordered, ordered.indexOf(c));
    bindPhotos(ordered);
    if (ADMIN) bindSiteAdmin(s);
  }

  // ---------- 라이트박스 ----------
  let lbList = [], lbI = 0;
  function bindPhotos(list) {
    app.querySelectorAll('.ph[data-i]').forEach(el => el.onclick = () => openLB(list, +el.dataset.i));
  }
  function openLB(list, i) { if (!list.length) return; lbList = list; lbI = i; $('#lb').hidden = false; document.body.style.overflow = 'hidden'; showLB(); }
  function closeLB() {
    if ($('#lb').hidden) return;
    $('#lb').hidden = true; document.body.style.overflow = '';
    if (pendingReload) { pendingReload = false; scheduleReload(); }
  }
  function showLB() {
    const p = lbList[lbI], s = siteById[p.site];
    if (!p || !s) return closeLB();
    $('#lbImg').src = imgUrl(p.l);
    $('#lbCap').textContent = `${s.name} · ${p.space} · ${PH_NAME[p.phase]}`;
    $('#lbSite').href = '#/site/' + s.id;
    $('#lbSite').hidden = location.hash === '#/site/' + s.id;
    $('#lbN').textContent = `${lbI + 1} / ${lbList.length}`;
    [lbList[lbI + 1], lbList[lbI - 1]].forEach(n => n && (new Image().src = imgUrl(n.l)));
    if (ADMIN) lbEditor(p);
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
  });
  let tx = null;
  $('#lb').addEventListener('touchstart', e => tx = e.touches[0].clientX, { passive: true });
  $('#lb').addEventListener('touchend', e => {
    if (tx == null) return;
    const dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });

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
      <p>견적 작업실과 같은 계정으로 로그인하세요.</p>
      <input type="email" id="lgEmail" placeholder="이메일" autocomplete="username" required>
      <input type="password" id="lgPw" placeholder="비밀번호" autocomplete="current-password" required>
      <button class="btn primary" type="submit">로그인</button>
      <p class="err">${esc(msg)}</p></form>`;
    $('#login').onsubmit = async e => {
      e.preventDefault();
      const { data, error } = await sb.auth.signInWithPassword({ email: $('#lgEmail').value.trim(), password: $('#lgPw').value });
      if (error) return viewLogin('로그인 실패: 이메일/비밀번호를 확인하세요.');
      session = data.session;
      await afterLogin();
    };
  }

  // --- 현장 편집 ---
  function siteAdminBar(s) {
    if (s.kind === 'etc') return `<div class="adminbar"><a class="btn" href="#/upload?site=etc">＋ 사진 추가</a></div>`;
    return `<div class="adminbar">
      <a class="btn primary" href="#/upload?site=${s.id}">＋ 사진 추가</a>
      <button class="btn" data-a="edit">정보 수정</button>
      <button class="btn" data-a="hide">${s.hidden ? '고객에게 보이기' : '고객에게 숨기기'}</button>
      <button class="btn" data-a="top">맨 앞으로</button>
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
    act('top').onclick = async () => {
      const { error } = await sb.from('pf_sites').update({ sort: Date.now() / 1000 }).eq('id', s.id);
      if (error) return toast('실패: ' + error.message);
      toast('현장 목록 맨 앞으로 옮겼어요'); scheduleReload();
    };
    act('del').onclick = async () => {
      const ps = DATA.photos.filter(p => p.site === s.id);
      if (!confirm(`"${s.name}" 현장과 사진 ${ps.length}장을 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
      await removeFiles(ps);
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

  // --- 사진 편집 (라이트박스 아래) ---
  function lbEditor(p) {
    const sites = DATA.sites.filter(s => s.kind === 'site');
    const s = siteById[p.site];
    $('#lbEdit').innerHTML = `<div class="lb-edit">
      <select data-e="space">${allSpaces().map(sp => `<option ${sp === p.space ? 'selected' : ''}>${esc(sp)}</option>`).join('')}<option value="__new">+ 새 공간…</option></select>
      <select data-e="phase">${PH_ORDER.map(ph => `<option value="${ph}" ${ph === p.phase ? 'selected' : ''}>${PH_NAME[ph]}</option>`).join('')}</select>
      <select data-e="site"><option value="etc" ${p.site === 'etc' ? 'selected' : ''}>${esc(CFG.etcName)}</option>${sites.map(x => `<option value="${x.id}" ${x.id === p.site ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      ${s.kind === 'site' ? `<button data-e="cover" ${s.cover === p.id ? 'disabled' : ''}>${s.cover === p.id ? '대표사진 ✓' : '대표사진으로'}</button>` : ''}
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
    ed('del').onclick = async () => {
      if (!confirm('이 사진을 삭제할까요?')) return;
      const { error } = await sb.from('pf_photos').delete().eq('id', p.id);
      if (error) return toast('실패: ' + error.message);
      await removeFiles([p]);
      DATA.photos = DATA.photos.filter(x => x !== p);
      lbList = lbList.filter(x => x !== p);
      render();
      if (!lbList.length) closeLB(); else { lbI = Math.min(lbI, lbList.length - 1); showLB(); }
    };
  }
  async function removeFiles(ps) {
    const paths = ps.flatMap(p => [p.t, p.l]);
    for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
  }

  // --- 올리기 ---
  const IMG = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i;
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
            <input type="file" id="upFiles" accept="image/*" multiple hidden>
            <b>4. 사진 선택</b><small id="pickHint">${pickHint()}</small>
          </label>
          ${queueHTML()}
        </section>

        ${canFolder ? `<section class="panel">
          <h2>폴더 통째로 올리기 <small>노트북</small></h2>
          <p class="help">정리해 둔 폴더를 고르면 현장·단계·공간을 폴더 이름으로 알아서 나눠요. 이미 올린 사진은 건너뛰어요.</p>
<pre class="tree">사진\\  (또는 현장\\, 현장 폴더 하나)
 ├ 현장\\송파 헬리오시티\\공사전\\거실\\…
 │                    \\공사후\\주방\\…
 ├ 현장\\분당 아파트\\거실\\…      ← 단계 폴더 없으면 공사후
 └ 기타작업\\거실\\…              ← 현장명 없는 사진</pre>
          <label class="btn"><input type="file" id="upDir" webkitdirectory multiple hidden>폴더 고르기</label>
          <div id="dirPlan"></div>
        </section>` : ''}

        <section class="panel">
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
      const siteId = await resolveSite();
      if (siteId === undefined) return;
      enqueue(files.map(file => ({ file, siteId, phase: up.phase, space: up.space })));
    };
    if ($('#upDir')) $('#upDir').onchange = e => planFolder([...e.target.files]);
    $('#logout').onclick = async () => { await sb.auth.signOut(); localStorage.removeItem(CACHE); location.reload(); };
    bindLinkBox();
  }
  function ready() { return up.site && (up.site !== '__new' || up.newName.trim()) && up.space; }
  function pickHint() {
    if (!up.site) return '먼저 현장을 고르세요';
    if (up.site === '__new' && !up.newName.trim()) return '새 현장 이름을 적어주세요';
    if (!up.space) return '공간을 고르세요';
    const n = up.site === '__new' ? up.newName.trim() : siteById[up.site]?.name || CFG.etcName;
    return `${n} · ${PH_NAME[up.phase]} · ${up.space} 에 올라가요`;
  }
  function refreshPick() { const l = $('#pickLbl'); if (!l) return; l.classList.toggle('off', !ready()); $('#pickHint').textContent = pickHint(); }
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
  function enqueue(jobs) {
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
      catch (e) { console.warn(e); queue.failed.push(j.file.name); }
      updateQueueUI();
    }
    queue.running--;
    if (!queue.running) { scheduleReload(); if (queue.done) toast(`${queue.done}장 올렸어요`); }
  }
  window.addEventListener('beforeunload', e => { if (queue.running) { e.preventDefault(); e.returnValue = ''; } });

  async function uploadOne({ file, siteId, phase, space }) {
    const url = URL.createObjectURL(file);
    let img;
    try { img = new Image(); img.src = url; await img.decode(); }
    catch { URL.revokeObjectURL(url); throw new Error('이미지를 열 수 없음'); }
    const large = await toJpeg(img, 2000, 0.85), thumb = await toJpeg(img, 900, 0.8);
    URL.revokeObjectURL(url);
    const id = crypto.randomUUID(), uid = session.user.id;
    const t = `${uid}/${id}_t.jpg`, l = `${uid}/${id}_l.jpg`;
    const opt = { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false };
    let r = await sb.storage.from(BUCKET).upload(t, thumb.blob, opt); if (r.error) throw r.error;
    r = await sb.storage.from(BUCKET).upload(l, large.blob, opt);
    if (r.error) { await sb.storage.from(BUCKET).remove([t]); throw r.error; }
    const ins = await sb.from('pf_photos').insert({ id, site_id: siteId, phase, space, t, l, w: thumb.w, h: thumb.h, src_name: file.name, src_size: file.size });
    if (ins.error) { await sb.storage.from(BUCKET).remove([t, l]); throw ins.error; }
  }
  function toJpeg(img, max, q) {
    const W = img.naturalWidth, H = img.naturalHeight, s = Math.min(1, max / Math.max(W, H));
    const w = Math.round(W * s), h = Math.round(H * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
    return new Promise((res, rej) => c.toBlob(b => b ? res({ blob: b, w, h }) : rej(new Error('변환 실패')), 'image/jpeg', q));
  }

  // --- 폴더 통째로 ---
  let plan = null;
  async function planFolder(files) {
    const parts = f => f.webkitRelativePath.split('/');
    const isRoot = n => ['현장', '기타작업'].includes(clean(n));
    const photoRoot = files.some(f => parts(f).length > 2 && isRoot(parts(f)[1]));
    const items = [], infos = {}, skipped = [];
    for (const f of files) {
      const ps = parts(f), name = ps[ps.length - 1];
      let rest = ps.slice(1, -1), root = clean(ps[0]), site;
      if (photoRoot) { if (rest.length && isRoot(rest[0])) { root = clean(rest[0]); rest = rest.slice(1); } else root = '기타작업'; }
      if (root === '현장') { if (rest.length) { site = clean(rest[0]); rest = rest.slice(1); } else site = null; }
      else if (root === '기타작업') site = null;
      else site = clean(ps[0]);
      if (/^(정보|info)\.txt$/i.test(name) && site && !rest.length) { infos[site] = await f.text(); continue; }
      if (name.startsWith('.') || name.startsWith('~')) continue;
      if (!IMG.test(name)) { if (!/\.(txt|ini|db|ds_store)$/i.test(name)) skipped.push(f.webkitRelativePath); continue; }
      let phase = 'after';
      if (site && rest.length && phaseOf(rest[0])) { phase = phaseOf(rest[0]); rest = rest.slice(1); }
      items.push({ file: f, siteName: site, phase, space: rest.length ? spaceOf(rest[0]) : '기타' });
    }
    // 이미 올린 사진 건너뛰기
    const nameToId = Object.fromEntries(DATA.sites.filter(s => s.kind === 'site').map(s => [s.name, s.id]));
    const have = new Set(DATA.photos.map(p => `${p.site}|${p.src_name}|${p.src_size}`));
    const todo = items.filter(it => !have.has(`${it.siteName === null ? 'etc' : nameToId[it.siteName] || '?'}|${it.file.name}|${it.file.size}`));
    const groups = {};
    for (const it of todo) { const k = it.siteName ?? '\u0000'; (groups[k] = groups[k] || []).push(it); }
    plan = { todo, infos, groups };
    $('#dirPlan').innerHTML = `<div class="planbox">
      <b>새로 올릴 사진 ${todo.length}장</b>${items.length - todo.length ? ` <small>(이미 올린 ${items.length - todo.length}장 건너뜀)</small>` : ''}
      <ul>${Object.entries(groups).map(([k, arr]) => {
        const by = countBy(arr, 'phase');
        return `<li><b>${k === '\u0000' ? esc(CFG.etcName) : esc(k)}</b>${k !== '\u0000' && !nameToId[k] ? ' <span class="tag">새 현장</span>' : ''}
          <small>${PH_ORDER.filter(ph => by[ph]).map(ph => `${PH_NAME[ph]} ${by[ph]}`).join(' · ')} — ${sortSpaces(arr.map(i => i.space)).join(', ')}</small></li>`;
      }).join('')}</ul>
      ${skipped.length ? `<p class="err">사진이 아닌 파일 ${skipped.length}개는 빼요</p>` : ''}
      ${todo.length ? `<button class="btn primary" id="dirGo">${todo.length}장 올리기</button>` : ''}</div>`;
    if ($('#dirGo')) $('#dirGo').onclick = runFolder;
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
        }
      }
      for (const it of arr) jobs.push({ file: it.file, siteId, phase: it.phase, space: it.space });
    }
    $('#dirPlan').innerHTML = '';
    enqueue(jobs);
  }

  async function afterLogin() {
    app.innerHTML = '<p class="none">불러오는 중…</p>';
    try { await fetchAll(); }
    catch (e) { app.innerHTML = `<div class="empty"><h2>서버 연결 문제</h2><p>${esc(e.message)}</p><p>Supabase에 <b>supabase.sql</b>을 실행했는지 확인하세요.</p></div>`; return; }
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
    if (ADMIN && !session) return viewLogin();
    if (!loaded) return;
    if (route === 'upload' && ADMIN) return viewUpload(new URLSearchParams(qs || ''));
    if (!DATA.photos.length && route !== 'site' && route !== 'sites')
      return app.innerHTML = ADMIN
        ? `<div class="empty"><h2>아직 사진이 없어요</h2><p>위의 <b>＋ 올리기</b>에서 사진을 올려보세요. 노트북·아이폰·아이패드 어디서 올려도 바로 반영돼요.</p><a class="btn primary" href="#/upload">사진 올리러 가기</a></div>`
        : '<p class="none">준비 중이에요.</p>';
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
      const { data } = await sb.auth.getSession();
      session = data.session;
      sb.auth.onAuthStateChange((_e, s) => { session = s; });
      if (!session) return render();
      if (loaded) render();
      return afterLogin();
    }
    if (loaded) render();
    try { await fetchAll(); render(); subscribe(); }
    catch (e) { console.warn(e); if (!loaded) app.innerHTML = '<p class="none">잠시 후 다시 열어주세요.</p>'; }
  })();
})();
