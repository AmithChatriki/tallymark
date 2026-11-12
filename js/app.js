/* Tallymark: static mock-exam app. No framework, no build step.
   Sections: storage, helpers, data loading + validation, attempt lifecycle, timer,
   views (home, exam, review, report), routing. */
(() => {
  'use strict';

  // ---------- Storage (versioned keys; everything stays in this browser) ----------
  const NS = 'mockexam:v1:';
  const KEY = {
    theme: NS + 'theme',
    history: NS + 'history',
    attempt: (mockId) => NS + 'attempt:' + mockId,
  };
  const ATTEMPT_VERSION = 1;
  const HISTORY_LIMIT = 200;

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
    // Removes attempts and history for every schema version; keeps the theme choice.
    clearData() {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('mockexam:') && k !== KEY.theme)
          .forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* ignore */ }
    },
  };

  // ---------- Small helpers ----------
  const $ = (id) => document.getElementById(id);
  const LETTERS = 'ABCDEFGH';

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // Renders plain text with `inline code`; never uses innerHTML.
  function inline(text) {
    const frag = document.createDocumentFragment();
    String(text).split('`').forEach((part, i) => {
      if (!part) return;
      frag.append(i % 2 ? h('code', null, part) : document.createTextNode(part));
    });
    return frag;
  }
  function paragraphs(text) {
    return String(text).split(/\n\s*\n/).map((p) => h('p', null, inline(p.trim())));
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    if (hh) return `${hh}h ${String(mm).padStart(2, '0')}m`;
    if (mm) return `${mm}m ${String(ss).padStart(2, '0')}s`;
    return `${ss}s`;
  }
  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return new Date(ts).toISOString().slice(0, 16).replace('T', ' '); }
  }
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- State ----------
  const state = {
    manifest: null,
    mocks: new Map(),      // mockId -> { meta, ok, error, questions, byId, domainName, issues }
    attempt: null,         // in-progress attempt currently open
    notice: null,          // one-off message shown on the home screen
    navOpen: false,        // question navigator visibility on narrow screens
    reviewFilter: 'all',
    reportFilter: { status: 'all', domain: 'all' },
    lastTick: 0,
    lastSave: 0,
    timerHandle: null,
    toastHandle: null,
  };

  // ---------- Data loading and validation ----------
  async function fetchJson(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path} (HTTP ${res.status})`);
    return res.json();
  }

  // Largest-remainder split of N questions across domain weightings.
  function expectedDistribution(domains, total) {
    const sum = domains.reduce((a, d) => a + d.weight, 0) || 1;
    const rows = domains.map((d) => {
      const exact = (d.weight / sum) * total;
      return { id: d.id, count: Math.floor(exact), rem: exact - Math.floor(exact) };
    });
    let left = total - rows.reduce((a, r) => a + r.count, 0);
    [...rows].sort((a, b) => b.rem - a.rem).forEach((r) => { if (left > 0) { r.count += 1; left -= 1; } });
    return Object.fromEntries(rows.map((r) => [r.id, r.count]));
  }

  function validateMock(meta, data) {
    const issues = [];
    const qs = Array.isArray(data && data.questions) ? data.questions : [];
    if (qs.length !== meta.questionCount) {
      issues.push(`question count is ${qs.length}, manifest says ${meta.questionCount}`);
    }
    const domainIds = new Set(meta.domains.map((d) => d.id));
    const seen = new Set();
    const perDomain = {};
    for (const q of qs) {
      const where = `question ${q && q.id ? q.id : '(no id)'}`;
      if (!q || typeof q.id !== 'string' || !q.id) { issues.push(`${where}: missing id`); continue; }
      if (seen.has(q.id)) issues.push(`${where}: duplicate id`);
      seen.add(q.id);
      if (!domainIds.has(q.domain)) issues.push(`${where}: unknown domain "${q.domain}"`);
      perDomain[q.domain] = (perDomain[q.domain] || 0) + 1;
      if (!q.stem) issues.push(`${where}: missing stem`);
      if (!q.taskStatement) issues.push(`${where}: missing taskStatement`);
      if (q.type !== 'single' && q.type !== 'multiple') issues.push(`${where}: type must be "single" or "multiple"`);
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2) issues.push(`${where}: needs at least two options`);
      const optIds = new Set();
      for (const o of opts) {
        if (!o.id || optIds.has(o.id)) issues.push(`${where}: missing or duplicate option id "${o.id}"`);
        optIds.add(o.id);
        if (!o.text) issues.push(`${where}: option ${o.id} has no text`);
        if (!o.explanation) issues.push(`${where}: option ${o.id} has no explanation`);
      }
      const correct = Array.isArray(q.correctOptionIds) ? q.correctOptionIds : [];
      for (const c of correct) if (!optIds.has(c)) issues.push(`${where}: correctOptionId "${c}" is not an option`);
      if (new Set(correct).size !== correct.length) issues.push(`${where}: repeated correctOptionIds`);
      if (q.type === 'single' && (q.selectCount !== 1 || correct.length !== 1)) {
        issues.push(`${where}: single-answer question needs selectCount 1 and exactly one correct option`);
      }
      if (q.type === 'multiple' && (!(q.selectCount >= 2) || correct.length !== q.selectCount || q.selectCount >= opts.length)) {
        issues.push(`${where}: multiple-response question needs selectCount >= 2 matching the number of correct options`);
      }
    }
    const expected = expectedDistribution(meta.domains, meta.questionCount);
    for (const d of meta.domains) {
      const actual = perDomain[d.id] || 0;
      if (actual !== expected[d.id]) {
        issues.push(`domain ${d.id} has ${actual} questions, weighting of ${d.weight}% implies ${expected[d.id]}`);
      }
    }
    return issues;
  }

  async function loadAll() {
    state.manifest = await fetchJson('data/manifest.json');
    const metas = state.manifest.mocks || [];
    const results = await Promise.allSettled(metas.map((m) => fetchJson(m.file)));
    metas.forEach((meta, i) => {
      const entry = { meta, ok: false, error: null, questions: [], byId: new Map(), issues: [] };
      entry.domainName = Object.fromEntries(meta.domains.map((d) => [d.id, d.name]));
      const r = results[i];
      if (r.status === 'rejected') {
        entry.error = `Could not load ${meta.file}: ${r.reason && r.reason.message ? r.reason.message : r.reason}`;
        console.error(`[validation] ${meta.id}: ${entry.error}`);
      } else {
        entry.issues = validateMock(meta, r.value);
        entry.questions = Array.isArray(r.value.questions) ? r.value.questions : [];
        entry.byId = new Map(entry.questions.map((q) => [q.id, q]));
        entry.ok = entry.questions.length > 0;
        if (entry.issues.length) {
          entry.issues.forEach((msg) => console.error(`[validation] ${meta.id}: ${msg}`));
        } else {
          console.info(`[validation] ${meta.id}: OK (${entry.questions.length} questions)`);
        }
      }
      state.mocks.set(meta.id, entry);
    });
  }

  // ---------- Scoring ----------
  const isAnswered = (q, sel) => Array.isArray(sel) && sel.length === q.selectCount;
  function isCorrect(q, sel) {
    if (!isAnswered(q, sel)) return false;
    const want = new Set(q.correctOptionIds);
    return sel.every((id) => want.has(id));
  }

  // ---------- Attempt lifecycle ----------
  function saveAttempt() {
    if (!state.attempt) return;
    store.set(KEY.attempt(state.attempt.mockId), state.attempt);
    state.lastSave = performance.now();
  }

  // Returns { attempt } | { discarded: true } | null. Saved progress is keyed by question ID,
  // so edits and reordering are fine; a changed set of IDs means the attempt is discarded.
  function readSavedAttempt(mockId) {
    const mock = state.mocks.get(mockId);
    const saved = store.get(KEY.attempt(mockId), null);
    if (!saved || !mock || !mock.ok) return null;
    const ids = mock.questions.map((q) => q.id).sort();
    const valid = saved.v === ATTEMPT_VERSION && saved.mockId === mockId &&
      Array.isArray(saved.qids) && saved.qids.length === ids.length && saved.qids.every((x, i) => x === ids[i]) &&
      saved.answers && typeof saved.answers === 'object';
    if (!valid) {
      store.remove(KEY.attempt(mockId));
      return { discarded: true };
    }
    // Drop selections that point at options that no longer exist.
    for (const [qid, sel] of Object.entries(saved.answers)) {
      const q = mock.byId.get(qid);
      const optIds = new Set(q.options.map((o) => o.id));
      const clean = Array.isArray(sel) ? sel.filter((id) => optIds.has(id)).slice(0, q.selectCount) : [];
      if (clean.length) saved.answers[qid] = clean; else delete saved.answers[qid];
    }
    saved.flags = saved.flags || {};
    saved.timeSpent = saved.timeSpent || {};
    saved.checked = saved.checked || {};
    saved.warned = saved.warned || {};
    if (!mock.byId.has(saved.currentQid)) saved.currentQid = mock.questions[0].id;
    return { attempt: saved };
  }

  function startAttempt(mockId, mode, timed) {
    const mock = state.mocks.get(mockId);
    state.attempt = {
      v: ATTEMPT_VERSION,
      id: uid(),
      mockId,
      mode,                         // 'exam' | 'practice'
      timed,                        // exam mode is always timed
      startedAt: Date.now(),
      remainingMs: mock.meta.durationMinutes * 60000,
      elapsedMs: 0,
      paused: false,
      currentQid: mock.questions[0].id,
      answers: {}, flags: {}, timeSpent: {}, checked: {}, warned: {},
      qids: mock.questions.map((q) => q.id).sort(),
    };
    state.navOpen = false;
    saveAttempt();
    go('#/exam');
  }

  function resumeAttempt(mockId) {
    const res = readSavedAttempt(mockId);
    if (!res || res.discarded) {
      state.notice = 'Your saved attempt no longer matches the current question bank, so it was discarded.';
      render();
      return;
    }
    state.attempt = res.attempt;
    state.attempt.paused = false;
    state.navOpen = false;
    go('#/exam');
  }

  function finalize(auto) {
    const att = state.attempt;
    if (!att) return;
    const mock = state.mocks.get(att.mockId);
    const perQuestion = {};
    const domains = mock.meta.domains.map((d) => ({ id: d.id, name: d.name, weight: d.weight, total: 0, correct: 0 }));
    const dIndex = Object.fromEntries(domains.map((d) => [d.id, d]));
    let correct = 0, answered = 0;
    for (const q of mock.questions) {
      const sel = att.answers[q.id] || [];
      const ok = isCorrect(q, sel);
      const ans = isAnswered(q, sel);
      if (ok) correct += 1;
      if (ans) answered += 1;
      if (dIndex[q.domain]) { dIndex[q.domain].total += 1; if (ok) dIndex[q.domain].correct += 1; }
      perQuestion[q.id] = {
        selected: sel, correct: ok, answered: ans,
        flagged: !!att.flags[q.id], timeMs: Math.round(att.timeSpent[q.id] || 0),
        domain: q.domain, taskStatement: q.taskStatement,
      };
    }
    const total = mock.questions.length;
    const percent = total ? (correct / total) * 100 : 0;
    const record = {
      id: att.id, mockId: att.mockId, mockTitle: mock.meta.title, exam: mock.meta.exam,
      mode: att.mode, timed: att.timed, autoSubmitted: !!auto,
      startedAt: att.startedAt, finishedAt: Date.now(), durationMs: Math.round(att.elapsedMs),
      total, correct, answered, percent: Math.round(percent * 10) / 10,
      passingScore: mock.meta.passingScore, passed: percent >= mock.meta.passingScore,
      domains, perQuestion,
    };
    const history = store.get(KEY.history, []);
    history.unshift(record);
    const saved = store.set(KEY.history, history.slice(0, HISTORY_LIMIT));
    store.remove(KEY.attempt(att.mockId));
    state.attempt = null;
    state.lastReport = record; // fallback if storage is unavailable
    stopTimer();
    if (!saved) state.notice = 'This browser blocked storage, so the report could not be saved to your history.';
    state.reportFilter = { status: 'all', domain: 'all' };
    go('#/report/' + record.id);
  }

  // ---------- Timer ----------
  function startTimer() {
    stopTimer();
    state.lastTick = performance.now();
    state.timerHandle = setInterval(tick, 250);
  }
  function stopTimer() {
    if (state.timerHandle) clearInterval(state.timerHandle);
    state.timerHandle = null;
  }

  function tick() {
    const att = state.attempt;
    const now = performance.now();
    const delta = now - state.lastTick;
    state.lastTick = now;
    if (!att || att.paused) return;
    att.elapsedMs += delta;
    if (route().name === 'exam') att.timeSpent[att.currentQid] = (att.timeSpent[att.currentQid] || 0) + delta;
    if (att.timed) {
      att.remainingMs -= delta;
      if (att.remainingMs <= 0) {
        att.remainingMs = 0;
        closeDialog();
        showToast('Time is up. Your answers were submitted automatically.', true);
        finalize(true);
        return;
      }
      if (!att.warned.ten && att.remainingMs <= 10 * 60000) {
        att.warned.ten = true;
        if (att.remainingMs > 5 * 60000) showToast('10 minutes remaining.', false);
      }
      if (!att.warned.five && att.remainingMs <= 5 * 60000) {
        att.warned.five = true;
        showToast('5 minutes remaining.', true);
      }
    }
    paintTimer();
    if (now - state.lastSave > 5000) saveAttempt();
  }

  function paintTimer() {
    const att = state.attempt;
    const box = $('hdr-timer');
    if (!att) { box.hidden = true; return; }
    box.hidden = false;
    const value = att.timed ? fmtClock(att.remainingMs) : fmtClock(Math.floor(att.elapsedMs / 1000) * 1000);
    const node = $('hdr-timer-value');
    if (node.textContent !== value) node.textContent = value;
    $('hdr-timer-label').textContent = att.paused ? 'Paused' : (att.timed ? 'Time left' : 'Elapsed');
    box.classList.toggle('warn', att.timed && att.remainingMs <= 10 * 60000 && att.remainingMs > 5 * 60000);
    box.classList.toggle('crit', att.timed && att.remainingMs <= 5 * 60000);
  }

  function showToast(message, critical) {
    const t = $('toast');
    t.textContent = message;
    t.className = 'toast show' + (critical ? ' crit' : '');
    clearTimeout(state.toastHandle);
    state.toastHandle = setTimeout(() => { t.className = 'toast'; t.textContent = ''; }, 9000);
  }

  // ---------- Dialog ----------
  let dialogResolve = null;
  function openDialog({ title, body, actions }) {
    const dlg = $('dlg');
    $('dlg-title').textContent = title;
    $('dlg-body').replaceChildren(...[].concat(body));
    $('dlg-actions').replaceChildren(...actions.map((a) => h('button', {
      type: 'button', class: 'btn ' + (a.kind || ''), autofocus: a.autofocus,
      onclick: () => { const r = dialogResolve; dialogResolve = null; dlg.close(); if (r) r(a.value); },
    }, a.label)));
    return new Promise((resolve) => {
      dialogResolve = resolve;
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
  }
  function closeDialog() {
    const dlg = $('dlg');
    if (dlg.open) dlg.close();
  }
  $('dlg').addEventListener('close', () => { const r = dialogResolve; dialogResolve = null; if (r) r(null); });

  const confirmDialog = (title, text, okLabel, kind) => openDialog({
    title, body: [].concat(text).map((t) => h('p', null, t)),
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind: kind || 'btn-primary', autofocus: true }],
  });

  // ---------- Header ----------
  function paintHeader(context, progress) {
    $('hdr-context').replaceChildren(...[].concat(context || []));
    const p = $('hdr-progress');
    p.hidden = !progress;
    p.textContent = progress || '';
    const att = state.attempt;
    const onExam = !!att && ['exam', 'review'].includes(route().name);
    $('hdr-timer').hidden = !onExam;
    const pause = $('pause-btn');
    pause.hidden = !(onExam && att.mode === 'practice');
    if (!pause.hidden) pause.textContent = att.paused ? 'Resume' : 'Pause';
    if (onExam) paintTimer();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = $('theme-btn');
    btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
    btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0E0E0E' : '#E7E0D1');
  }
  $('theme-btn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set(KEY.theme, next);
  });
  $('pause-btn').addEventListener('click', () => {
    const att = state.attempt;
    if (!att || att.mode !== 'practice') return;
    att.paused = !att.paused;
    saveAttempt();
    render();
  });

  // ---------- Routing ----------
  function route() {
    const parts = (location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean);
    return { name: parts[0] || 'home', arg: parts[1] || null };
  }
  function go(hash) {
    if (location.hash === hash) render(); else location.hash = hash;
  }

  function render() {
    const r = route();
    const app = $('app');
    if ((r.name === 'exam' || r.name === 'review') && !state.attempt) { go('#/'); return; }
    if (state.attempt && (r.name === 'exam' || r.name === 'review')) {
      if (!state.timerHandle) startTimer();
    } else if (state.timerHandle) {
      // Leaving the exam screens stops the clock; progress stays saved for "Resume".
      saveAttempt();
      stopTimer();
      state.attempt = null;
    }
    let view;
    if (r.name === 'exam') view = viewExam();
    else if (r.name === 'review') view = viewReview();
    else if (r.name === 'report') view = viewReport(r.arg);
    else {
      const exam = r.name !== 'home' && exams().find((e) => e.slug === r.name);
      view = exam ? viewExamHome(exam) : viewHome();
    }
    document.body.classList.toggle('bg-on', !['exam', 'review', 'report'].includes(r.name));
    app.replaceChildren(...[].concat(view));
  }

  // ---------- Home ----------
  // Exams come from manifest.exams; any examCode without an entry still gets a page.
  function exams() {
    const list = [];
    const declared = (state.manifest && state.manifest.exams) || [];
    for (const e of declared) list.push({ code: e.code, slug: e.slug, name: e.name, summary: e.summary || '', mocks: [] });
    for (const mock of state.mocks.values()) {
      const code = mock.meta.examCode || mock.meta.exam;
      let e = list.find((x) => x.code === code);
      if (!e) {
        e = { code, slug: String(code).toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: mock.meta.exam, summary: '', mocks: [] };
        list.push(e);
      }
      e.mocks.push(mock);
    }
    return list.filter((e) => e.mocks.length);
  }
  const examForMock = (mockId) => exams().find((e) => e.mocks.some((m) => m.meta.id === mockId));

  function noticesFor(mocks) {
    const out = [];
    if (state.notice) {
      out.push(h('p', { class: 'notice', role: 'status' }, state.notice));
      state.notice = null;
    }
    const withIssues = mocks.filter((m) => m.issues.length);
    if (withIssues.length) {
      out.push(h('p', { class: 'notice notice-error' },
        `Question bank validation reported problems in ${withIssues.map((m) => m.meta.title).join(', ')}. Details are in the browser console.`));
    }
    return out;
  }

  // Reads every saved attempt once; stale ones are discarded here and reported.
  function savedAttempts(mocks) {
    const inProgress = [];
    const discarded = [];
    for (const mock of mocks) {
      const saved = readSavedAttempt(mock.meta.id);
      if (saved && saved.discarded) discarded.push(mock);
      else if (saved && saved.attempt) inProgress.push({ mock, attempt: saved.attempt });
    }
    return { inProgress, discarded };
  }
  const discardNotice = (list) => list.length ? h('p', { class: 'notice', role: 'status' },
    `Your saved attempt on ${list.map((m) => m.meta.title).join(', ')} no longer matched the current question bank, so it was discarded.`) : null;
  const answeredCount = (mock, a) => mock.questions.filter((q) => isAnswered(q, a.answers[q.id])).length;

  function viewHome() {
    paintHeader(h('span', null, 'Practice exams'));
    document.title = 'Tallymark | Unofficial practice exams for the Claude Certified Architect exams';
    const all = [...state.mocks.values()];
    const { inProgress, discarded } = savedAttempts(all);
    const out = [h('div', { class: 'home-wrap' },
      h('div', { class: 'eyebrow' }, 'Claude Certified Architect · practice exams'),
      h('h1', { class: 'display' }, 'Which exam are you preparing for?'),
      h('p', { class: 'lede' }, 'Full-length, timed mocks with an explanation for every option. Free, no account.'),
      ...noticesFor(all), discardNotice(discarded),
      h('div', { class: 'picker' }, ...exams().map((e) => {
        const first = e.mocks[0].meta;
        const counts = [...new Set(e.mocks.map((m) => m.meta.questionCount))].join('/');
        return h('a', { class: 'tile', href: '#/' + e.slug, 'aria-label': `${e.name}: ${e.mocks.length} mocks` },
          h('div', { class: 'tile-top' }, h('span', { class: 'code' }, e.code), h('span', { class: 'level' }, first.exam.replace(/^.*–\s*/, ''))),
          h('h2', null, e.name),
          e.summary ? h('p', null, e.summary) : null,
          h('div', { class: 'tile-meta' },
            h('span', null, h('b', null, String(e.mocks.length)), e.mocks.length === 1 ? ' mock' : ' mocks'),
            h('span', null, h('b', null, counts), ' questions'),
            h('span', null, h('b', null, String(first.durationMinutes)), ' min'),
            h('span', { class: 'tile-go', 'aria-hidden': 'true' }, 'Choose →')));
      })),
      ...inProgress.map(({ mock, attempt }) => h('div', { class: 'continue' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', null, h('strong', null, mock.meta.title),
          ` in progress · ${attempt.mode === 'exam' ? 'Exam' : 'Practice'} mode · ${answeredCount(mock, attempt)} of ${mock.questions.length} answered`),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => resumeAttempt(mock.meta.id) }, 'Resume'))),
      h('p', { class: 'foot-note' }, 'Your progress is stored only in this browser. There are no accounts and no data leaves your device.'))];
    return out;
  }

  function viewExamHome(exam) {
    paintHeader(h('span', null, exam.name));
    document.title = `${exam.name} practice exams | Tallymark`;
    const first = exam.mocks[0].meta;
    const ids = new Set(exam.mocks.map((m) => m.meta.id));
    const history = store.get(KEY.history, []).filter((x) => ids.has(x.mockId));
    const { inProgress, discarded } = savedAttempts(exam.mocks);
    const counts = [...new Set(exam.mocks.map((m) => m.meta.questionCount))].join('/');
    return [h('div', { class: 'home-wrap' },
      h('a', { class: 'back', href: '#/' }, '← All exams'),
      h('div', { class: 'eyebrow', style: 'margin-top:22px' }, exam.code),
      h('h1', { class: 'display' }, exam.name),
      h('p', { class: 'lede' }, `${counts} questions · ${first.durationMinutes} minutes · pass mark ${first.passingScore}%`),
      h('ul', { class: 'chips', 'aria-label': 'Domain weightings' },
        ...first.domains.map((d) => h('li', { class: 'chip' }, d.name, h('b', null, `${d.weight}%`)))),
      ...noticesFor(exam.mocks), discardNotice(discarded),
      h('div', { class: 'mocks' }, ...exam.mocks.map((mock) =>
        mockCard(mock, exam, history, (inProgress.find((x) => x.mock === mock) || {}).attempt))),
      h('section', { class: 'hist' },
        h('div', { class: 'section-head' }, h('h2', null, `Your ${exam.name} attempts`),
          h('span', { class: 'small muted' }, history.length ? `${history.length} attempt${history.length === 1 ? '' : 's'}` : '')),
        historyTable(history)),
      h('p', { class: 'foot-note' }, 'Progress is stored only in this browser. ',
        h('button', { type: 'button', class: 'link-danger', onclick: clearAllData }, 'Clear all data')))];
  }

  function mockCard(mock, exam, history, attempt) {
    const m = mock.meta;
    const mine = history.filter((x) => x.mockId === m.id);
    const best = mine.length ? Math.max(...mine.map((x) => x.percent)) : null;
    const shortTitle = m.title.replace(new RegExp('^' + exam.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+'), '');
    let line = mine.length ? `${mine.length} attempt${mine.length === 1 ? '' : 's'}` : 'Not attempted yet';
    if (attempt) line = `In progress · ${attempt.mode === 'exam' ? 'Exam' : 'Practice'} · ${answeredCount(mock, attempt)} of ${mock.questions.length}` +
      (attempt.timed ? ` · ${fmtClock(attempt.remainingMs)} left` : '');
    const card = h('article', { class: 'mk' },
      h('div', { class: 'mk-head' },
        h('div', null, h('h3', null, shortTitle), h('div', { class: 'mk-line' }, line)),
        h('div', { class: 'mk-best' }, h('div', { class: 'n' }, best == null ? '–' : `${Math.round(best)}%`), h('div', { class: 'l' }, 'Best'))));
    if (!mock.ok) {
      card.append(h('p', { class: 'notice notice-error', style: 'margin:0' },
        mock.error || 'This mock contains no questions.',
        location.protocol === 'file:' ? ' The site must be served over HTTP; opening index.html directly does not work.' : ''));
      return card;
    }
    const actions = h('div', { class: 'mk-actions' });
    if (attempt) {
      const pct = Math.round((answeredCount(mock, attempt) / mock.questions.length) * 100);
      card.append(h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Questions answered' },
        h('i', { style: `width:${pct}%` })));
      actions.append(
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => resumeAttempt(m.id) }, 'Resume'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => startDialog(m.id, true) }, 'Start new'));
    } else {
      actions.append(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => startDialog(m.id, false) }, 'Start'));
      if (mine.length) actions.append(h('a', { class: 'btn btn-quiet', href: '#/report/' + mine[0].id, style: 'text-decoration:none' }, 'Last report'));
    }
    card.append(actions);
    return card;
  }

  function historyTable(history) {
    if (!history.length) return h('div', { class: 'panel empty' }, 'No attempts yet. Completed mocks will be listed here with their reports.');
    const rows = history.map((x) => h('tr', null,
      h('td', null, fmtDate(x.finishedAt)),
      h('td', null, x.mockTitle),
      h('td', null, x.mode === 'exam' ? 'Exam' : 'Practice'),
      h('td', { class: 'num' }, `${x.correct}/${x.total} (${Math.round(x.percent)}%)`),
      h('td', null, h('span', { class: 'tag ' + (x.passed ? 'tag-pass' : 'tag-fail') }, x.passed ? 'Pass' : 'Fail')),
      h('td', { class: 'num' }, fmtDuration(x.durationMs)),
      h('td', null, h('a', { href: '#/report/' + x.id, 'aria-label': `Open report for ${x.mockTitle}, ${fmtDate(x.finishedAt)}` }, 'Report'))));
    return h('div', { class: 'panel tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ...['Date', 'Mock', 'Mode', 'Score', 'Result', 'Time taken', ''].map((t, i) =>
        h('th', { scope: 'col', class: i === 3 || i === 5 ? 'num' : null }, t)))),
      h('tbody', null, rows)));
  }

  async function clearAllData() {
    const ok = await confirmDialog('Clear all data?',
      'This permanently deletes saved progress, attempt history and reports stored in this browser. It cannot be undone.',
      'Clear all data', 'btn-danger');
    if (!ok) return;
    store.clearData();
    state.lastReport = null;
    state.notice = 'All saved data was cleared.';
    render();
  }

  async function startDialog(mockId, hasSaved) {
    const m = state.mocks.get(mockId).meta;
    const choice = (name, value, title, desc, checked) => {
      const input = h('input', { type: 'radio', name, value, checked });
      return h('label', { class: 'choice' + (checked ? ' selected' : '') }, input,
        h('span', null, h('span', { class: 'choice-title' }, title), h('span', { class: 'choice-desc' }, desc)));
    };
    const timing = h('fieldset', { hidden: true },
      h('legend', null, 'Practice timing'),
      choice('timing', 'untimed', 'Untimed', 'No countdown. Elapsed time is still recorded.', true),
      choice('timing', 'timed', 'Timed, can be paused', `${m.durationMinutes}-minute countdown with a Pause button.`, false));
    const modes = h('fieldset', null,
      h('legend', null, 'Mode'),
      choice('mode', 'exam', 'Exam mode', `${m.durationMinutes}-minute countdown, no feedback until you submit, auto-submit at zero.`, true),
      choice('mode', 'practice', 'Practice mode', 'Check each answer as you go and read the explanation for every option.', false));
    const body = h('div', null,
      h('p', { class: 'muted' }, `${m.exam}. ${m.questionCount} questions, pass mark ${m.passingScore}%.`),
      hasSaved ? h('p', { class: 'notice' }, 'Starting a new attempt discards the attempt you have in progress for this mock.') : null,
      modes, timing);
    body.addEventListener('change', () => {
      body.querySelectorAll('.choice').forEach((c) => c.classList.toggle('selected', c.querySelector('input').checked));
      timing.hidden = body.querySelector('input[name="mode"]:checked').value !== 'practice';
    });
    const ok = await openDialog({
      title: `Start ${m.title}`, body,
      actions: [{ label: 'Cancel', value: false }, { label: 'Start', value: true, kind: 'btn-primary' }],
    });
    if (!ok) return;
    const mode = body.querySelector('input[name="mode"]:checked').value;
    const timed = mode === 'exam' || body.querySelector('input[name="timing"]:checked').value === 'timed';
    startAttempt(mockId, mode, timed);
  }

  // ---------- Exam ----------
  function examContext() {
    const att = state.attempt;
    const mock = state.mocks.get(att.mockId);
    const qs = mock.questions;
    const answered = qs.filter((q) => isAnswered(q, att.answers[q.id])).length;
    const flagged = qs.filter((q) => att.flags[q.id]).length;
    return { att, mock, qs, answered, flagged, index: Math.max(0, qs.findIndex((q) => q.id === att.currentQid)) };
  }

  function gotoIndex(i) {
    const { att, qs } = examContext();
    if (i < 0 || i >= qs.length) return;
    att.currentQid = qs[i].id;
    saveAttempt();
    if (route().name !== 'exam') { go('#/exam'); return; }
    render();
    const head = $('q-heading');
    if (head) head.focus();
    window.scrollTo(0, 0);
  }

  function setAnswer(q, optId, checked) {
    const att = state.attempt;
    if (att.checked[q.id]) return;
    let sel = att.answers[q.id] ? [...att.answers[q.id]] : [];
    if (q.type === 'single') sel = [optId];
    else if (checked) { if (!sel.includes(optId) && sel.length < q.selectCount) sel.push(optId); }
    else sel = sel.filter((x) => x !== optId);
    if (sel.length) att.answers[q.id] = sel; else delete att.answers[q.id];
    saveAttempt();
    render();
    const again = $('opt-' + q.id + '-' + optId);
    if (again) again.focus();
  }

  function toggleFlag() {
    const att = state.attempt;
    if (att.flags[att.currentQid]) delete att.flags[att.currentQid]; else att.flags[att.currentQid] = true;
    saveAttempt();
    render();
    const b = $('flag-btn');
    if (b) b.focus();
  }

  // Shared option renderer. reveal = show correct/incorrect marks and explanations.
  function optionList(q, sel, { interactive, reveal }) {
    const full = q.type === 'multiple' && sel.length >= q.selectCount;
    const correct = new Set(q.correctOptionIds);
    const field = h('fieldset', { class: 'opts' },
      h('legend', { class: 'sr-only' }, q.type === 'multiple' ? `Select ${q.selectCount} options` : 'Select one option'));
    q.options.forEach((o, i) => {
      const chosen = sel.includes(o.id);
      const cls = ['opt'];
      if (chosen) cls.push('selected');
      if (!interactive) cls.push('locked');
      let status = null;
      if (reveal) {
        if (correct.has(o.id)) { cls.push('is-correct'); status = chosen ? 'Correct answer (your choice)' : 'Correct answer'; }
        else if (chosen) { cls.push('is-wrong'); status = 'Your choice (incorrect)'; }
      }
      const input = h('input', {
        type: q.type === 'single' ? 'radio' : 'checkbox',
        name: 'q-' + q.id, id: 'opt-' + q.id + '-' + o.id, value: o.id, checked: chosen,
        disabled: !interactive || (full && !chosen),
        onchange: interactive ? (e) => setAnswer(q, o.id, e.target.checked) : null,
      });
      field.append(h('label', { class: cls.join(' '), for: input.id },
        input,
        h('span', { class: 'opt-letter', 'aria-hidden': 'true' }, LETTERS[i]),
        h('span', { class: 'opt-body' },
          h('span', { class: 'opt-text' }, inline(o.text)),
          status ? h('span', { class: 'opt-status' }, status) : null,
          reveal ? h('span', { class: 'opt-exp' }, inline(o.explanation)) : null)));
    });
    return field;
  }

  function viewExam() {
    const { att, mock, qs, answered, index } = examContext();
    const q = qs[index];
    const sel = att.answers[q.id] || [];
    const practice = att.mode === 'practice';
    const checked = !!att.checked[q.id];
    document.title = `${mock.meta.title} | Tallymark`;
    paintHeader([h('strong', null, mock.meta.title), ` · ${practice ? 'Practice mode' : 'Exam mode'}`],
      `Answered ${answered}/${qs.length}`);

    const meta = h('div', { class: 'q-meta' },
      h('span', { class: 'q-count' }, `Question ${index + 1} of ${qs.length}`),
      q.type === 'multiple' ? h('span', { class: 'tag tag-select' }, `Select ${q.selectCount}`) : null,
      q.scenario ? h('span', { class: 'tag' }, q.scenario) : null,
      att.flags[q.id] ? h('span', { class: 'tag tag-flag' }, 'Flagged') : null);

    const panel = h('section', { class: 'panel q-panel', 'aria-labelledby': 'q-heading' },
      h('h1', { id: 'q-heading', class: 'sr-only', tabindex: '-1' }, `Question ${index + 1} of ${qs.length}`),
      meta,
      h('div', { class: 'q-stem' }, paragraphs(q.stem)),
      optionList(q, sel, { interactive: !checked && !att.paused, reveal: checked }));

    if (q.type === 'multiple') {
      panel.append(h('p', { class: 'select-hint', 'aria-live': 'polite' },
        sel.length >= q.selectCount
          ? `${sel.length} of ${q.selectCount} selected. Clear a choice to change your answer.`
          : `Select ${q.selectCount}. ${sel.length} of ${q.selectCount} selected.`));
    }

    if (practice) {
      const fb = h('div', { class: 'q-feedback' });
      if (checked) {
        const ok = isCorrect(q, sel);
        fb.append(h('p', { role: 'status' },
          h('span', { class: 'tag ' + (ok ? 'tag-correct' : 'tag-incorrect') }, ok ? 'Correct' : 'Incorrect'),
          ' ', h('span', { class: 'small muted' }, `${mock.domainName[q.domain] || q.domain} · ${q.taskStatement}`)),
          h('p', { class: 'small muted' }, 'This answer is now locked.'));
      } else {
        fb.append(h('button', {
          type: 'button', class: 'btn', id: 'check-btn', disabled: !isAnswered(q, sel),
          onclick: () => { att.checked[q.id] = true; saveAttempt(); render(); const hd = $('q-heading'); if (hd) hd.focus(); },
        }, 'Check answer'));
      }
      panel.append(fb);
    }

    panel.append(h('div', { class: 'q-actions' },
      h('button', { type: 'button', class: 'btn', disabled: index === 0, onclick: () => gotoIndex(index - 1) }, 'Previous'),
      h('button', { type: 'button', class: 'btn', disabled: index === qs.length - 1, onclick: () => gotoIndex(index + 1) }, 'Next'),
      h('button', { type: 'button', class: 'btn btn-flag', id: 'flag-btn', 'aria-pressed': att.flags[q.id] ? 'true' : 'false', onclick: toggleFlag },
        att.flags[q.id] ? 'Flagged for review' : 'Flag for review'),
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button', class: 'btn nav-toggle', 'aria-expanded': state.navOpen ? 'true' : 'false', 'aria-controls': 'nav-panel',
        onclick: () => { state.navOpen = !state.navOpen; render(); if (state.navOpen) window.scrollTo(0, 0); },
      }, state.navOpen ? 'Hide questions' : 'Questions'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('#/review') }, 'Review and submit')),
      h('p', { class: 'kbd-hint' }, 'Left and right arrow keys move between questions. F toggles the flag.'));

    if (att.paused) {
      panel.append(h('div', { class: 'paused-cover', role: 'status' },
        h('h2', null, 'Paused'), h('p', { class: 'muted' }, 'The timer is stopped and the question is hidden.'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { att.paused = false; saveAttempt(); render(); } }, 'Resume')));
    }

    return h('div', { class: 'exam' + (state.navOpen ? ' nav-open' : '') }, panel, navigator());
  }

  function navigator() {
    const { att, qs, answered, flagged, index } = examContext();
    const grid = h('div', { class: 'nav-grid' });
    qs.forEach((q, i) => {
      const ans = isAnswered(q, att.answers[q.id]);
      const cls = ['nav-btn'];
      const words = [`Question ${i + 1}`];
      if (att.checked[q.id]) cls.push(isCorrect(q, att.answers[q.id]) ? 'right' : 'wrong');
      else if (ans) cls.push('answered');
      words.push(ans ? 'answered' : 'unanswered');
      if (att.flags[q.id]) { cls.push('flagged'); words.push('flagged'); }
      if (i === index) cls.push('current');
      grid.append(h('button', {
        type: 'button', class: cls.join(' '), 'aria-label': words.join(', '),
        'aria-current': i === index ? 'true' : null,
        onclick: () => { state.navOpen = false; gotoIndex(i); },
      }, String(i + 1)));
    });
    const sample = (cls, label) => h('li', null, h('span', { class: 'nav-btn ' + cls, 'aria-hidden': 'true' }), label);
    return h('aside', { class: 'panel nav-panel', id: 'nav-panel', 'aria-label': 'Question navigator' },
      h('h2', null, 'Questions'),
      grid,
      h('ul', { class: 'legend' }, sample('current', 'Current'), sample('answered', 'Answered'), sample('', 'Unanswered'), sample('flagged', 'Flagged')),
      h('p', { class: 'nav-counts' }, `${answered} answered · ${qs.length - answered} unanswered · ${flagged} flagged`),
      h('button', { type: 'button', class: 'btn', style: 'width:100%', onclick: () => go('#/review') }, 'Review and submit'));
  }

  // ---------- Review before submission ----------
  function viewReview() {
    const { att, mock, qs, answered, flagged } = examContext();
    const unanswered = qs.length - answered;
    document.title = `Review | ${mock.meta.title} | Tallymark`;
    paintHeader([h('strong', null, mock.meta.title), ' · Review'], `Answered ${answered}/${qs.length}`);

    const stat = (label, value) => h('div', { class: 'panel stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, String(value)));
    const filters = [['all', `All (${qs.length})`], ['unanswered', `Unanswered (${unanswered})`], ['flagged', `Flagged (${flagged})`]];
    const list = h('ul', { class: 'rv-list' });
    qs.forEach((q, i) => {
      const ans = isAnswered(q, att.answers[q.id]);
      if (state.reviewFilter === 'unanswered' && ans) return;
      if (state.reviewFilter === 'flagged' && !att.flags[q.id]) return;
      list.append(h('li', { class: 'rv-item' }, h('button', { type: 'button', class: 'rv-row', onclick: () => gotoIndex(i) },
        h('span', { class: 'rv-num' }, String(i + 1)),
        h('span', { class: 'rv-text' }, q.stem.replace(/`/g, '').replace(/\s+/g, ' ')),
        att.flags[q.id] ? h('span', { class: 'tag tag-flag' }, 'Flagged') : null,
        h('span', { class: 'tag' + (ans ? ' tag-select' : '') }, ans ? 'Answered' : 'Unanswered'))));
    });

    return [
      h('div', { class: 'section-head' }, h('h1', null, 'Review before submitting'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onclick: () => go('#/exam') }, 'Return to questions'),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: submitDialog }, 'Submit'))),
      h('div', { class: 'stats' }, stat('Answered', answered), stat('Unanswered', unanswered), stat('Flagged', flagged)),
      h('section', { class: 'section' },
        h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter questions' }, filters.map(([key, label]) => h('button', {
          type: 'button', class: 'btn btn-chip', 'aria-pressed': state.reviewFilter === key ? 'true' : 'false',
          onclick: () => { state.reviewFilter = key; render(); },
        }, label))),
        h('div', { class: 'panel' }, list.children.length ? list : h('p', { class: 'empty' }, 'No questions match this filter.'))),
    ];
  }

  async function submitDialog() {
    const { qs, answered, flagged } = examContext();
    const unanswered = qs.length - answered;
    const lines = [];
    if (unanswered) lines.push(h('p', { class: 'notice notice-error' }, `${unanswered} question${unanswered === 1 ? ' is' : 's are'} unanswered and will be marked incorrect.`));
    if (flagged) lines.push(h('p', null, `${flagged} question${flagged === 1 ? ' is' : 's are'} still flagged for review.`));
    lines.push(h('p', null, 'Submitting ends this attempt. You cannot change answers afterwards.'));
    const ok = await openDialog({
      title: 'Submit this attempt?', body: lines,
      actions: [{ label: 'Keep working', value: false }, { label: 'Submit', value: true, kind: 'btn-primary' }],
    });
    if (ok && state.attempt) finalize(false);
  }

  // ---------- Report ----------
  function viewReport(id) {
    const history = store.get(KEY.history, []);
    const rec = history.find((x) => x.id === id) || (state.lastReport && state.lastReport.id === id ? state.lastReport : null);
    paintHeader(h('span', null, 'Results'));
    if (!rec) {
      return [h('h1', null, 'Report not found'),
        h('p', { class: 'muted', style: 'margin-top:8px' }, 'This report is not stored in this browser. It may have been cleared.'),
        h('p', null, h('a', { href: '#/' }, 'Back to practice exams'))];
    }
    const mock = state.mocks.get(rec.mockId);
    const bank = mock && mock.ok ? mock : null;
    const backExam = examForMock(rec.mockId);
    const backHref = backExam ? '#/' + backExam.slug : '#/';
    const backLabel = backExam ? `Back to ${backExam.name}` : 'Back to home';
    document.title = `Results: ${rec.mockTitle} | Tallymark`;
    const pq = rec.perQuestion || {};
    const ids = bank ? bank.questions.map((q) => q.id).filter((qid) => pq[qid]) : Object.keys(pq);
    // Questions answered in this attempt that have since been removed from the bank.
    const orphaned = Object.keys(pq).filter((qid) => !ids.includes(qid));
    const order = ids.concat(orphaned);

    const flaggedIds = order.filter((qid) => pq[qid].flagged);
    const plainIds = order.filter((qid) => !pq[qid].flagged);
    const acc = (list) => (list.length ? `${list.filter((qid) => pq[qid].correct).length}/${list.length} (${pct(list.filter((qid) => pq[qid].correct).length, list.length)}%)` : 'none');
    const need = Math.ceil((rec.passingScore / 100) * rec.total);

    const stat = (label, value, sub) => h('div', { class: 'panel stat' },
      h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'stat-sub' }, sub) : null);

    // Focus areas: weakest domains by accuracy, with their most-missed task statements.
    const weak = rec.domains.filter((d) => d.total && d.correct < d.total)
      .map((d) => ({ ...d, rate: d.correct / d.total }))
      .sort((a, b) => a.rate - b.rate || b.weight - a.weight)
      .filter((d, i) => d.rate * 100 < rec.passingScore || i < 2)
      .slice(0, 3);
    const weakIds = new Set(weak.map((d) => d.id));
    const focusItems = weak.map((d) => {
      const misses = {};
      order.forEach((qid) => {
        const r = pq[qid];
        if (r.domain === d.id && !r.correct && r.taskStatement) misses[r.taskStatement] = (misses[r.taskStatement] || 0) + 1;
      });
      const top = Object.entries(misses).sort((a, b) => b[1] - a[1]).slice(0, 2);
      return h('li', null, h('strong', null, d.name), ` (${d.correct}/${d.total} correct). `,
        top.length ? h('span', { class: 'muted' }, 'Revise: ' + top.map(([ts, n]) => `${ts} (${n} missed)`).join('; ') + '.') : null);
    });

    const domainRows = rec.domains.map((d) => {
      const p = pct(d.correct, d.total);
      const isWeak = weakIds.has(d.id);
      return h('tr', { class: isWeak ? 'weak' : null },
        h('td', null, d.name, isWeak ? [' ', h('span', { class: 'tag tag-fail' }, 'Revise')] : null),
        h('td', { class: 'num' }, `${d.weight}%`),
        h('td', { class: 'num' }, `${d.correct}/${d.total}`),
        h('td', { style: 'width:34%' }, h('div', { class: 'bar', role: 'img', 'aria-label': `${p}% correct` },
          h('div', { class: 'bar-fill' + (isWeak ? ' weak' : ''), style: `width:${p}%` }),
          h('div', { class: 'bar-mark', style: `left:${rec.passingScore}%` }))),
        h('td', { class: 'num' }, `${p}%`));
    });

    const out = [
      h('div', { class: 'section-head' },
        h('div', null, h('h1', null, `Results: ${rec.mockTitle}`),
          h('p', { class: 'small muted', style: 'margin:2px 0 0' },
            `${rec.exam} · ${rec.mode === 'exam' ? 'Exam mode' : 'Practice mode'} · ${fmtDate(rec.finishedAt)}` +
            (rec.autoSubmitted ? ' · submitted automatically when time ran out' : ''))),
        h('div', { class: 'row' },
          bank ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => startDialog(rec.mockId, !!(readSavedAttempt(rec.mockId) || {}).attempt) }, 'Retake this mock') : null,
          h('a', { class: 'btn', href: backHref, style: 'text-decoration:none' }, backLabel))),
    ];
    if (state.notice) { out.push(h('p', { class: 'notice', role: 'status' }, state.notice)); state.notice = null; }

    out.push(h('section', { class: 'panel verdict' },
      h('div', { class: 'verdict-pct' }, `${Math.round(rec.percent)}%`),
      h('div', { class: 'verdict-detail' },
        h('div', null, h('span', { class: 'tag ' + (rec.passed ? 'tag-pass' : 'tag-fail') }, rec.passed ? 'Pass' : 'Fail'),
          ' ', h('span', { class: 'num' }, `${rec.correct} / ${rec.total} correct`)),
        h('div', { class: 'small muted' }, `Pass mark ${rec.passingScore}% (${need} of ${rec.total}). Multiple-response items score only when every selection is right.`))));

    out.push(h('div', { class: 'stats', style: 'margin-top:10px' },
      stat('Time taken', fmtDuration(rec.durationMs)),
      stat('Average per question', fmtDuration(rec.total ? rec.durationMs / rec.total : 0)),
      stat('Answered', `${rec.answered}/${rec.total}`),
      stat('Flagged accuracy', acc(flaggedIds), `Not flagged: ${acc(plainIds)}`)));

    out.push(h('section', { class: 'section panel panel-pad focus' },
      h('h2', null, 'Focus areas'),
      focusItems.length ? h('ul', null, focusItems) : h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'No mistakes in this attempt, so there is nothing specific to revise.')));

    out.push(h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', null, 'Score by domain'),
        h('span', { class: 'small muted' }, `The marker on each bar is the ${rec.passingScore}% pass mark.`)),
      h('div', { class: 'panel tbl-wrap' }, h('table', null,
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Domain'), h('th', { scope: 'col', class: 'num' }, 'Weighting'),
          h('th', { scope: 'col', class: 'num' }, 'Score'), h('th', { scope: 'col' }, 'Accuracy'), h('th', { scope: 'col', class: 'num' }, ''))),
        h('tbody', null, domainRows)))));

    // Question-by-question review
    const f = state.reportFilter;
    const statusFilters = [['all', 'All'], ['incorrect', 'Incorrect'], ['flagged', 'Flagged'], ['unanswered', 'Unanswered']];
    const counts = {
      all: order.length,
      incorrect: order.filter((qid) => !pq[qid].correct).length,
      flagged: flaggedIds.length,
      unanswered: order.filter((qid) => !pq[qid].answered).length,
    };
    const domainSelect = h('select', { 'aria-label': 'Filter by domain', onchange: (e) => { f.domain = e.target.value; render(); } },
      h('option', { value: 'all' }, 'All domains'),
      rec.domains.map((d) => h('option', { value: d.id, selected: f.domain === d.id }, d.name)));
    const cards = [];
    order.forEach((qid, i) => {
      const r = pq[qid];
      if (f.status === 'incorrect' && r.correct) return;
      if (f.status === 'flagged' && !r.flagged) return;
      if (f.status === 'unanswered' && r.answered) return;
      if (f.domain !== 'all' && r.domain !== f.domain) return;
      cards.push(reportCard(i + 1, r, bank ? bank.byId.get(qid) : null, rec));
    });
    out.push(h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', null, 'Question review'),
        h('span', { class: 'small muted' }, `${cards.length} of ${order.length} shown`)),
      h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter reviewed questions' },
        statusFilters.map(([key, label]) => h('button', {
          type: 'button', class: 'btn btn-chip', 'aria-pressed': f.status === key ? 'true' : 'false',
          onclick: () => { f.status = key; render(); },
        }, `${label} (${counts[key]})`)),
        domainSelect),
      cards.length ? cards : h('div', { class: 'panel empty' }, 'No questions match these filters.')));
    return out;
  }

  function reportCard(number, r, q, rec) {
    const domain = (rec.domains.find((d) => d.id === r.domain) || {}).name || r.domain;
    const head = h('div', { class: 'rq-head' },
      h('span', { class: 'q-count' }, `Question ${number}`),
      h('span', { class: 'tag ' + (r.correct ? 'tag-correct' : 'tag-incorrect') }, r.correct ? 'Correct' : (r.answered ? 'Incorrect' : 'Unanswered')),
      r.flagged ? h('span', { class: 'tag tag-flag' }, 'Flagged') : null,
      q && q.type === 'multiple' ? h('span', { class: 'tag' }, `Select ${q.selectCount}`) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'small muted num' }, `Time ${fmtDuration(r.timeMs || 0)}`));
    const card = h('article', { class: 'panel rq' }, head,
      h('p', { class: 'rq-ts' }, `${domain} · ${r.taskStatement || ''}`));
    if (!q) {
      card.append(h('p', { class: 'muted' }, 'This question has since been removed from the question bank, so its text is no longer available.'));
      return card;
    }
    const sel = (r.selected || []).filter((x) => q.options.some((o) => o.id === x));
    const letter = (x) => LETTERS[q.options.findIndex((o) => o.id === x)];
    card.append(
      h('div', { class: 'q-stem' }, paragraphs(q.stem)),
      h('p', { class: 'small', style: 'margin:10px 0 0' },
        h('strong', null, 'Your answer: '), sel.length ? sel.map(letter).sort().join(', ') : 'none', ' · ',
        h('strong', null, 'Correct answer: '), q.correctOptionIds.map(letter).sort().join(', ')),
      optionList(q, sel, { interactive: false, reveal: true }));
    return card;
  }

  // ---------- Global events ----------
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  window.addEventListener('pagehide', saveAttempt);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveAttempt(); });

  document.addEventListener('keydown', (e) => {
    if (route().name !== 'exam' || !state.attempt || state.attempt.paused) return;
    if (e.altKey || e.ctrlKey || e.metaKey || $('dlg').open) return;
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['radio', 'checkbox'].includes(t.type)))) return;
    const { index } = examContext();
    // Arrow keys would otherwise move the selection inside a radio group.
    if (e.key === 'ArrowRight') { e.preventDefault(); gotoIndex(index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); gotoIndex(index - 1); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFlag(); }
  }, true);

  // ---------- Boot ----------
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  loadAll().then(render).catch((err) => {
    console.error('[load] ' + err.message);
    paintHeader(h('span', null, 'Practice exams'));
    $('app').replaceChildren(
      h('h1', null, 'The question banks could not be loaded'),
      h('p', { class: 'notice notice-error', style: 'margin-top:12px' }, `Failed to load data/manifest.json: ${err.message}`),
      h('p', { class: 'muted' }, location.protocol === 'file:'
        ? 'This page was opened directly from disk. Browsers block fetch() for local files, so serve the folder over HTTP instead, for example with: python -m http.server'
        : 'Check that the data folder was deployed alongside index.html, then reload the page.'));
  });
})();
