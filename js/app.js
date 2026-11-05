// Kanji Desk: screens, sessions and the glue to storage and the API.
// Answer checking is js/check.js, the quiz flow js/session.js, queues, related items, the
// item inspector and stats js/items.js, pitch accent js/pitch.js, and the API, sync and outbox
// js/wk.js. Classic scripts, no build step.
(function () {
  "use strict";
  const C = window.Check;
  const I = window.Items;
  const W = window.wanakana;
  const app = document.getElementById("app");
  const KEYS = { token: "kanjidesk.token.v1", settings: "kanjidesk.settings.v1", rejected: "kanjidesk.rejected.v1", demo: "kanjidesk.demo" };
  const DEFAULTS = {
    testMode: true,
    reviewOrder: "random",
    reviewLimit: 0,
    types: { radical: true, kanji: true, vocabulary: true },
    questionOrder: "random",
    backToBack: false,
    activeSize: 10,
    lightning: false,
    infoOnWrong: true,
    srsIndicator: true,
    autoplay: true,
    voice: "female",
    lessonBatch: 5,
    lessonOrder: "wk",
    apprenticeCap: 0,
    dailyCap: 0,
    lessonAutoplay: true,
    theme: "system",
    selfStudyKinds: "both",
    selfStudyLimit: 20,
    heatmap: "reviews",
    inspect: {
      from: 1,
      to: 60,
      types: { radical: true, kanji: true, vocabulary: true },
      states: { locked: false, lesson: false, apprentice: true, guru: true, master: true, enlightened: true, burned: false },
      extra: "none",
      sort: "level",
    },
  };
  const TYPE_NAME = { radical: "Radical", kanji: "Kanji", vocabulary: "Vocabulary", kana_vocabulary: "Vocabulary" };
  const TYPE_CLASS = { radical: "t-rad", kanji: "t-kan", vocabulary: "t-voc", kana_vocabulary: "t-voc" };
  const COLLECTION_NAME = { subjects: "Subjects", assignments: "Your items", review_statistics: "Stats", study_materials: "Notes", level_progressions: "Levels" };
  const TOKEN_URL = "https://www.wanikani.com/settings/personal_access_tokens";
  const MIN = 60e3;

  // ---------- storage ----------
  function load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Private windows can refuse storage. Settings then last for this tab only.
    }
  }
  const settings = Object.assign({}, DEFAULTS, load(KEYS.settings) || {});
  settings.types = Object.assign({}, DEFAULTS.types, settings.types);
  settings.inspect = Object.assign({}, DEFAULTS.inspect, settings.inspect);
  settings.inspect.types = Object.assign({}, DEFAULTS.inspect.types, settings.inspect.types);
  settings.inspect.states = Object.assign({}, DEFAULTS.inspect.states, settings.inspect.states);
  const saveSettings = () => save(KEYS.settings, settings);
  const getSetting = (key) => key.split(".").reduce((o, k) => (o == null ? o : o[k]), settings);

  let token = load(KEYS.token) || "";
  let demo = sessionStorage.getItem(KEYS.demo) === "1";
  let store = null;
  let api = null;
  let model = null;
  let history = []; // the last week of finished items on this device
  let allHistory = null; // all of it, loaded for the stats screen
  let pending = new Set(); // assignment ids answered and waiting in the outbox
  const practiced = new Set(); // test mode: answered this visit, not sent
  let outboxCount = 0;
  let rejected = load(KEYS.rejected) || [];
  const status = { syncing: false, progress: "", lastSync: 0, error: "", auth: false, offline: false };
  let setupError = "";

  let sess = null; // { kind: "reviews" | "lesson" | "practice", label, s }
  let lesson = null; // { batch, idx, phase: "teach" | "quiz" }
  let lessonQueue = []; // subject ids picked in the lesson picker, taught first
  const pickSel = new Set(); // the picker's current selection
  let last = null; // the finished session, for the summary screen
  let infoOpen = false;
  let infoAll = false; // also show the half still to be answered
  let lightningTimer = null;
  let toastTimer = null;
  const modalStack = [];

  const sending = () => !demo && !settings.testMode;
  const skipSet = () => new Set([...pending, ...practiced]);

  // ---------- small helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtHour = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric" });
  const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  function fmtDur(ms) {
    const h = Math.floor(ms / 3600e3);
    if (h < 24) return `${h} h ${Math.floor((ms % 3600e3) / MIN)} min`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
  }
  function fmtWhen(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? fmtTime(ms) : d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  const n = (x) => Number(x).toLocaleString();
  const primaryMeaning = (s) => (s.data.meanings.find((m) => m.primary) || s.data.meanings[0] || { meaning: "" }).meaning;
  const primaryReading = (s) => {
    const r = (s.data.readings || []).find((x) => x.primary) || (s.data.readings || [])[0];
    return r ? r.reading : "";
  };
  const glyphLen = (s) => Math.min(6, (s.data.characters || "x").length);
  // The characters, or the image for a radical that has none.
  function charsHTML(s) {
    if (s.data.characters) return esc(s.data.characters);
    const img = (s.data.character_images || []).find((x) => x.content_type === "image/svg+xml") || (s.data.character_images || [])[0];
    return img ? `<img class="rad-img" src="${esc(img.url)}" alt="${esc(primaryMeaning(s))}">` : esc(s.data.slug || "?");
  }
  // WaniKani's mnemonic markup: <radical>, <kanji>, <vocabulary>, <meaning>, <reading>, <ja>.
  function markup(text) {
    if (!text) return "";
    const tags = "radical|kanji|vocabulary|meaning|reading|ja";
    const html = esc(text)
      .replace(new RegExp(`&lt;(${tags})&gt;`, "g"), '<span class="mk mk-$1">')
      .replace(new RegExp(`&lt;/(${tags})&gt;`, "g"), "</span>");
    return html.split(/\n+/).map((p) => `<p>${p}</p>`).join("");
  }
  function stageOf(s) {
    const a = model.bySubject.get(s.id);
    return a && a.data.started_at ? a.data.srs_stage : a && a.data.unlocked_at ? 0 : -1;
  }
  function chip(s, sub) {
    const st = stageOf(s);
    const stage = st >= 0 ? `<span class="chip-st g-${I.stageGroup(st)}" title="${esc(st ? I.STAGE_NAMES[st] : "Not learned yet")}"></span>` : "";
    return `<button class="chip ${TYPE_CLASS[s.object]}" data-act="open" data-id="${s.id}">
      <span class="chip-c" lang="ja">${charsHTML(s)}</span>
      <span class="chip-m">${esc(primaryMeaning(s))}${s.data.readings ? ` <span lang="ja">${esc(primaryReading(s))}</span>` : ""}</span>
      ${sub ? `<span class="chip-s">${sub}</span>` : ""}${stage}
    </button>`;
  }
  const chips = (list, sub) => `<div class="chips">${list.map((s) => chip(s, sub && sub(s))).join("")}</div>`;
  function paint(html) {
    app.innerHTML = html;
  }
  function screenOf() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    return [parts[0] || "home", parts[1]];
  }
  function nav(screen) {
    const h = `#/${screen === "home" ? "" : screen}`;
    if (location.hash === h || (screen === "home" && !location.hash)) render();
    else location.hash = h;
  }
  function applyTheme() {
    document.documentElement.classList.toggle("light", settings.theme === "light");
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
  }

  // ---------- audio ----------
  const player = new Audio();
  // One clip per pronunciation, in your chosen voice when there is one.
  function audioFor(s) {
    const clips = (s.data.pronunciation_audios || []).filter((a) => a.content_type === "audio/mpeg");
    const byPron = new Map();
    for (const c of clips) {
      const key = c.metadata.pronunciation;
      const best = byPron.get(key);
      if (!best || (c.metadata.gender === settings.voice && best.metadata.gender !== settings.voice)) byPron.set(key, c);
    }
    return [...byPron.values()];
  }
  function play(s, pron) {
    const clips = audioFor(s);
    const clip = clips.find((c) => c.metadata.pronunciation === pron) || clips[0];
    if (!clip) return;
    player.src = clip.url;
    player.play().catch(() => {});
  }

  // ---------- data ----------
  async function openData() {
    allHistory = null;
    lessonQueue = [];
    pickSel.clear();
    if (demo) {
      store = Store.memory();
      const d = Demo.build(Date.now());
      await store.setMeta("user", d.user);
      for (const name of Store.DATA) await store.putMany(name, d[name]);
      api = null;
    } else {
      store = await Store.open("kanji-desk");
      api = WK.client(token, { onWait: (secs) => setProgress(`WaniKani asked us to slow down. Waiting ${secs} s…`) });
    }
    await loadModel();
    if (!model.user) {
      render();
      await syncNow();
      if (!model.user) {
        // The first download failed: back to setup with the reason.
        setupError = status.error || "Could not download your data.";
        if (status.auth) forgetToken();
      }
    }
    render();
    flushNow();
    if (!demo && Date.now() - status.lastSync > 2 * MIN) syncNow();
  }

  async function loadModel() {
    const [user, ...lists] = await Promise.all([store.getMeta("user"), ...Store.DATA.map((name) => store.getAll(name))]);
    const [subjects, assignments, review_statistics, study_materials, level_progressions] = lists;
    model = I.buildModel({ user, subjects, assignments, review_statistics, study_materials, level_progressions });
    const box = await store.getAll("outbox");
    pending = new Set(box.map((e) => e.assignmentId));
    outboxCount = box.length;
    status.lastSync = (await store.getMeta("lastSync")) || 0;
    const week = Date.now() - 7 * 24 * 3600e3;
    history = (await store.getAll("history")).filter((h) => h.at >= week);
  }

  // The store as the sync sees it: every page also goes straight into the model.
  const syncStore = {
    getMeta: (k) => store.getMeta(k),
    setMeta: (k, v) => store.setMeta(k, v),
    async putMany(name, items) {
      await store.putMany(name, items);
      I.apply(model, name, items);
    },
  };

  function setProgress(text) {
    status.progress = text;
    paintStatus();
  }

  async function syncNow() {
    if (demo || !api || status.syncing) return;
    status.syncing = true;
    status.error = "";
    setProgress("Syncing…");
    try {
      await flushNow();
      const r = await WK.sync(api, syncStore, (p) => setProgress(`Syncing ${COLLECTION_NAME[p.name]}: ${n(p.got)} of ${n(p.total)}`));
      model.user = r.user;
      status.lastSync = Date.now();
      await store.setMeta("lastSync", status.lastSync);
      status.auth = false;
      status.offline = false;
    } catch (e) {
      status.error = e.message;
      status.auth = e.status === 401;
      status.offline = e.status === 0;
    } finally {
      status.syncing = false;
      status.progress = "";
    }
    refreshHome();
  }

  let flushing = null;
  function flushNow() {
    if (demo || !api) return Promise.resolve();
    if (flushing) return flushing;
    flushing = (async () => {
      const r = await WK.flush(api, { list: () => store.getAll("outbox"), remove: (id) => store.remove("outbox", id) }, {
        onSent: async (e, res) => {
          const updated = e.kind === "start" ? res : res && res.resources_updated && res.resources_updated.assignment;
          if (updated && updated.id) {
            await store.putMany("assignments", [updated]);
            I.apply(model, "assignments", [updated]);
          }
          const stat = e.kind === "review" && res && res.resources_updated && res.resources_updated.review_statistic;
          if (stat && stat.id) {
            await store.putMany("review_statistics", [stat]);
            I.apply(model, "review_statistics", [stat]);
          }
        },
        onRejected: (e, err) => {
          const a = model.assignments.get(e.assignmentId);
          const s = a && model.subjects.get(a.data.subject_id);
          rejected.push({ at: Date.now(), kind: e.kind, chars: s ? s.data.characters || s.data.slug : "?", message: err.message });
          rejected = rejected.slice(-20);
          save(KEYS.rejected, rejected);
        },
      });
      const box = await store.getAll("outbox");
      pending = new Set(box.map((e) => e.assignmentId));
      outboxCount = box.length;
      if (r.stopped === "auth") status.auth = true;
      status.offline = r.stopped === "offline";
      if (r.rejected) setTimeout(syncNow, 1000); // refresh what the server really has
      paintStatus();
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  // An item is finished in a session: log it, and queue it for WaniKani unless this is practice
  // or test mode.
  async function finished(f) {
    const e = f.entry;
    const at = Date.now();
    const h = { subjectId: e.subject.id, at, wrongMeaning: f.wrongMeaning, wrongReading: f.wrongReading, mode: sess.kind };
    history.push(h);
    if (allHistory) allHistory.push(h);
    store.add("history", h);
    if (sess.kind === "practice" || !e.assignment) return;
    if (!sending()) {
      practiced.add(e.assignment.id);
      return;
    }
    const entry = sess.kind === "lesson"
      ? { kind: "start", assignmentId: e.assignment.id, at, unlockedAt: Date.parse(e.assignment.data.unlocked_at) || 0 }
      : { kind: "review", assignmentId: e.assignment.id, wrongMeaning: f.wrongMeaning, wrongReading: f.wrongReading, at };
    await store.add("outbox", entry);
    pending.add(entry.assignmentId);
    outboxCount++;
    flushNow();
  }

  function forgetToken() {
    token = "";
    localStorage.removeItem(KEYS.token);
  }

  // ---------- setup ----------
  function viewSetup() {
    return `<div class="setup">
      <h1>Kanji Desk</h1>
      <p class="lede">An unofficial review app for WaniKani. Reviews and lessons in any browser, with reordering, undo, similar kanji and more built in.</p>
      <ol class="steps">
        <li>Open <a href="${TOKEN_URL}" target="_blank" rel="noopener">WaniKani → Settings → API Tokens</a>.</li>
        <li>Make a new token. Tick the two permissions to <b>start assignments</b> and <b>create reviews</b>. Leave the rest off.</li>
        <li>Paste it here.</li>
      </ol>
      <form id="tokenform" class="tokenform" autocomplete="off">
        <input id="tokenin" type="password" placeholder="Your API token" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="WaniKani API token">
        <button class="btn primary">Connect</button>
      </form>
      ${setupError ? `<p class="err">${esc(setupError)}</p>` : ""}
      <p class="muted small">The token stays in this browser and is only ever sent to api.wanikani.com. Test mode is on at first: answers are checked but nothing is sent until you turn it off in Settings.</p>
      <p><button class="btn" data-act="demo">Try the demo first</button> <span class="muted small">Made-up items. Nothing is sent anywhere.</span></p>
    </div>`;
  }
  async function connect(value) {
    const t = value.trim();
    if (!t) return;
    setupError = "";
    const btn = $("#tokenform button");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      await WK.client(t).user();
    } catch (e) {
      setupError = e.message;
      return render();
    }
    token = t;
    save(KEYS.token, token);
    demo = false;
    sessionStorage.removeItem(KEYS.demo);
    await openData();
  }

  function viewLoading() {
    const failed = !status.syncing && status.error;
    return `<div class="setup"><h1>Kanji Desk</h1>
      <p class="lede">Downloading your WaniKani data. The first time takes a minute or two; after that only changes are fetched.</p>
      <p class="status ${failed ? "bad" : ""}" id="status">${esc(failed ? status.error : status.progress || "Starting…")}</p>
      ${failed ? `<div class="row"><button class="btn primary" data-act="sync">Try again</button><button class="btn" data-act="signout">Use a different token</button></div>` : ""}</div>`;
  }

  // ---------- home ----------
  function statusLine() {
    if (demo) return `Demo: made-up items, nothing is sent. <button class="link" data-act="exitdemo">Leave the demo</button>`;
    if (status.syncing) return esc(status.progress || "Syncing…");
    const waiting = outboxCount ? ` · ${outboxCount} answer${outboxCount === 1 ? "" : "s"} waiting to send` : "";
    if (status.auth) return `<span class="bad">WaniKani refused the token.</span> Check it in <a href="#/settings">Settings</a>.${waiting}`;
    if (status.offline) return `Offline. Answers are kept and sent when you are back online.${waiting}`;
    if (status.error) return `<span class="bad">${esc(status.error)}</span>${waiting}`;
    return `${status.lastSync ? `Synced ${fmtWhen(status.lastSync)}` : "Not synced yet"}${waiting}`;
  }
  function paintStatus() {
    const el = $("#status");
    if (!el) return;
    if (!model || !model.user) el.textContent = status.progress || status.error || "Starting…";
    else el.innerHTML = statusLine();
  }
  function refreshHome() {
    if (screenOf()[0] === "home" && model && !modalStack.length) render();
    else paintStatus();
  }

  function forecastHTML(buckets, dueNow) {
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const peak = buckets.findIndex((b) => b.count === max);
    let running = dueNow;
    const rows = [];
    const cols = buckets.map((b, i) => {
      running += b.count;
      if (b.count) rows.push(`<tr><td>${fmtHour(b.at)}</td><td>${b.count}</td><td>${running}</td></tr>`);
      const h = b.count ? Math.max(6, Math.round((100 * b.count) / max)) : 0;
      const tip = `${fmtHour(b.at)}: ${b.count} new, ${running} in total`;
      return `<div class="fc-col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
        ${i === peak && b.count ? `<span class="fc-val" style="bottom:${h}%">${b.count}</span>` : ""}
        <div class="fc-bar" style="height:${h}%"></div>
      </div>`;
    });
    const ticks = buckets.map((b, i) => `<span>${i % 6 === 0 ? fmtHour(b.at) : ""}</span>`).join("");
    const total = buckets.reduce((s, b) => s + b.count, 0);
    return `<section class="card">
      <h2>Next 24 hours <span class="muted">+${total}</span></h2>
      ${total ? `<div class="fc" role="img" aria-label="Reviews arriving each hour for the next 24 hours">${cols.join("")}</div><div class="fc-ticks">${ticks}</div>
      <details class="fc-table"><summary>As a list</summary><table><thead><tr><th>At</th><th>New</th><th>Total</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>`
        : `<p class="muted">Nothing new in the next 24 hours.</p>`}
    </section>`;
  }

  function viewHome() {
    const now = Date.now();
    const skip = skipSet();
    const due = I.reviewsDue(model, now, skip);
    const toReview = I.filterReviews(due, { types: settings.types, limit: settings.reviewLimit });
    const lessons = I.lessonsAvailable(model, skip);
    const c = I.counts(model, now);
    const room = I.lessonRoom(model, now, settings);
    const prog = I.levelProgress(model);
    const mistakes = I.recentMistakes(model, history, now);
    const leech = I.leeches(model);
    const u = model.user.data;
    const resume = sess && sess.s.current() && sess.kind !== "lesson";
    const capNote = [];
    if (settings.apprenticeCap > 0) capNote.push(`Apprentice ${c.apprentice} of ${settings.apprenticeCap}`);
    else capNote.push(`Apprentice ${c.apprentice}`);
    if (settings.dailyCap > 0) capNote.push(`today ${c.lessonsToday} of ${settings.dailyCap}`);
    const lessonCount = Math.min(lessons.length, room);
    const waiting = new Set(lessons.map((e) => e.subject.id));
    const picked = lessonQueue.filter((id) => waiting.has(id)).length;
    const onLevel = I.levelTimes(model, now).find((x) => x.current && x.level === u.level);
    const orderOpts = Object.entries(I.REVIEW_ORDERS).map(([k, v]) => `<option value="${k}" ${settings.reviewOrder === k ? "selected" : ""}>${v}</option>`).join("");
    const limitOpts = [0, 10, 20, 30, 50, 100].map((v) => `<option value="${v}" ${settings.reviewLimit === v ? "selected" : ""}>${v ? `${v} at most` : "All of them"}</option>`).join("");
    const typeBox = (k, label) => `<label class="tog"><input type="checkbox" data-set="types.${k}" ${settings.types[k] ? "checked" : ""}> ${label}</label>`;
    return `
      <header class="top hometop">
        <div><h1>Kanji Desk</h1><p class="muted small">${esc(u.username)} · level ${u.level}</p></div>
        <nav class="topnav">
          ${demo ? "" : `<button class="btn small" data-act="sync" ${status.syncing ? "disabled" : ""}>Sync</button>`}
          <a class="btn small" href="#/search">Search</a>
          <a class="btn small" href="#/items">Items</a>
          <a class="btn small" href="#/stats">Stats</a>
          <a class="btn small" href="#/settings">Settings</a>
        </nav>
      </header>
      <p class="status muted small" id="status">${statusLine()}</p>
      ${!demo && settings.testMode ? `<p class="banner">Test mode is on: answers are checked but <b>nothing is sent to WaniKani</b>. Turn it off in <a href="#/settings">Settings</a> once you trust the app.</p>` : ""}
      ${rejected.length ? `<p class="banner bad">WaniKani refused ${rejected.length} answer${rejected.length === 1 ? "" : "s"}, most likely already done on another device: ${rejected.slice(-3).map((r) => `<span lang="ja">${esc(r.chars)}</span> (${esc(r.message)})`).join(", ")}. <button class="link" data-act="clearrejected">Dismiss</button></p>` : ""}
      ${resume ? `<p class="banner">You left a session with ${sess.s.stats().remaining} items to go. <button class="btn small primary" data-act="resume">Resume</button></p>` : ""}
      <div class="duo">
        <section class="card big-card">
          <h2>Lessons</h2>
          <p class="hero">${lessonCount}</p>
          <p class="muted small">${lessons.length > lessonCount ? `${lessons.length} waiting; your caps allow ${lessonCount}. ` : ""}${picked ? `${picked} you picked go first. ` : ""}${capNote.join(" · ")}</p>
          <button class="btn primary wide" data-act="lessons" ${lessonCount ? "" : "disabled"}>Start lessons</button>
          ${lessons.length ? `<a class="btn wide small pickbtn" href="#/pick">Pick lessons</a>` : ""}
        </section>
        <section class="card big-card">
          <h2>Reviews</h2>
          <p class="hero">${toReview.length}</p>
          <p class="muted small">${toReview.length < due.length ? `${due.length} due; your filters pick ${toReview.length}` : "Due now"}</p>
          <button class="btn primary wide" data-act="reviews" ${toReview.length ? "" : "disabled"}>Start reviews</button>
        </section>
      </div>
      <details class="card opts" ${settings.reviewOrder !== "random" || settings.reviewLimit || !settings.types.radical || !settings.types.kanji || !settings.types.vocabulary ? "open" : ""}>
        <summary>Review order and filters</summary>
        <label class="field">Order <select data-set="reviewOrder">${orderOpts}</select></label>
        <label class="field">How many <select data-set="reviewLimit" data-num>${limitOpts}</select></label>
        <div class="field">Include ${typeBox("radical", "Radicals")} ${typeBox("kanji", "Kanji")} ${typeBox("vocabulary", "Vocabulary")}</div>
      </details>
      ${forecastHTML(I.forecast(model, now, 24, skip), due.length)}
      <section class="card">
        <h2>Level ${prog.level}${onLevel ? ` <span class="muted small">${fmtDur(onLevel.ms)} so far</span>` : ""}</h2>
        <p>${!prog.total ? "No kanji at this level." : `${prog.passed} of ${prog.total} kanji at Guru or above. ${prog.passed >= prog.need ? "Enough to level up." : `${prog.need - prog.passed} more to level up.`}`}</p>
        <div class="meter" role="img" aria-label="${prog.passed} of ${prog.total} kanji passed"><span style="width:${prog.total ? (100 * prog.passed) / prog.total : 0}%"></span><i style="left:90%"></i></div>
        <p class="spread small">
          <span><b>${n(c.apprentice)}</b> Apprentice</span><span><b>${n(c.guru)}</b> Guru</span><span><b>${n(c.master)}</b> Master</span>
          <span><b>${n(c.enlightened)}</b> Enlightened</span><span><b>${n(c.burned)}</b> Burned</span>
        </p>
        <p class="small"><a href="#/stats">Time on each level and your heatmap →</a></p>
      </section>
      <section class="card">
        <h2>Extra practice <span class="muted small">nothing is sent</span></h2>
        <div class="row">
          <button class="btn" data-act="practice" data-which="mistakes" ${mistakes.length ? "" : "disabled"}>Recent mistakes (${mistakes.length})</button>
          <button class="btn" data-act="practice" data-which="leeches" ${leech.length ? "" : "disabled"}>Leeches (${leech.length})</button>
        </div>
        <p class="muted small">Recent mistakes: items you missed in the last 24 hours on this device. Leeches: items you keep missing, from your WaniKani stats. For any other set, use <a href="#/items">Items</a> and its self-study quiz.</p>
      </section>
      <footer class="foot muted small">Kanji Desk is an unofficial app. It is not made by, or linked to, WaniKani or Tofugu. Item content comes from the WaniKani API and belongs to Tofugu.</footer>`;
  }

  // ---------- sessions ----------
  function makeSession(kind, entries, label, extra = {}) {
    sess = {
      kind,
      label,
      s: Session.create(entries, Object.assign({
        activeSize: settings.activeSize,
        questionOrder: settings.questionOrder,
        backToBack: settings.backToBack,
        strict: kind === "reviews" && settings.reviewOrder !== "random",
      }, extra)),
    };
    infoOpen = false;
    infoAll = false;
  }

  async function startReviews() {
    if (sending() && Date.now() - status.lastSync > MIN && navigator.onLine) {
      const btn = $('[data-act="reviews"]');
      if (btn) btn.textContent = "Syncing…";
      await syncNow();
    }
    const now = Date.now();
    const due = I.reviewsDue(model, now, skipSet());
    const ordered = I.orderReviews(due, settings.reviewOrder, { now, level: model.user.data.level });
    const entries = I.filterReviews(ordered, { types: settings.types, limit: settings.reviewLimit });
    if (!entries.length) return nav("home");
    makeSession("reviews", entries, "Reviews");
    nav("quiz");
  }

  function startPractice(which) {
    const entries = which === "leeches" ? I.leeches(model).map((x) => x.entry) : I.recentMistakes(model, history, Date.now());
    if (!entries.length) return;
    makeSession("practice", I.shuffle(entries), which === "leeches" ? "Leeches · practice" : "Mistakes · practice");
    nav("quiz");
  }

  async function startLessons() {
    if (sending() && Date.now() - status.lastSync > MIN && navigator.onLine) await syncNow();
    const now = Date.now();
    const room = I.lessonRoom(model, now, settings);
    const list = I.orderLessons(I.lessonsAvailable(model, skipSet()), settings.lessonOrder);
    // Picked items first. They leave the queue once started (they are then no longer waiting).
    const byId = new Map(list.map((e) => [e.subject.id, e]));
    lessonQueue = lessonQueue.filter((id) => byId.has(id));
    const picked = lessonQueue.map((id) => byId.get(id));
    const batch = (picked.length ? picked : list).slice(0, Math.min(settings.lessonBatch, room));
    if (!batch.length) return nav("home");
    lesson = { batch, idx: 0, phase: "teach", seen: new Set([0]) };
    nav("lessons");
  }

  function viewSession() {
    const leaveTip = sess.kind === "practice" ? "Leave" : "Leave. Finished items are saved; unfinished ones come back next time.";
    return `<div class="sess">
      <header class="sbar">
        <button class="icon" data-act="quit" title="${esc(leaveTip)}" aria-label="Leave">✕</button>
        <span class="slabel">${esc(sess.label)}</span>
        <span class="sprog" id="sprog"></span>
        ${sess.kind === "lesson" ? "" : `<button class="btn small" id="wrapbtn" data-act="wrap">Wrap up</button>`}
      </header>
      ${sess.kind !== "practice" && !sending() ? `<p class="testflag">${demo ? "Demo" : "Test mode"}: nothing is sent</p>` : ""}
      <section class="qcard" id="qcard"><div class="qchars" id="qchars" lang="ja"></div><div class="toast" id="toast" aria-live="polite"></div>
        <div class="qconf" id="qconf" aria-live="polite"></div></section>
      <div class="qprompt" id="qprompt"></div>
      <form id="qform" class="qform" autocomplete="off">
        <input id="qin" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="go" aria-label="Your answer">
        <button class="qgo" aria-label="Submit">↵</button>
      </form>
      <div class="qnote" id="qnote" aria-live="polite"></div>
      <div class="qacts" id="qacts"></div>
      <div class="qinfo" id="qinfo"></div>
      <p class="keys muted small">Keys: Enter answers and moves on · Backspace retypes · + or − marks right or wrong · F item info (again: everything) · E everything · J audio</p>
    </div>`;
  }

  let imeOn = false;
  function setIME(input, on) {
    if (on === imeOn) return;
    if (on) W.bind(input, { IMEMode: true });
    else W.unbind(input);
    imeOn = on;
  }

  function paintProgress() {
    const st = sess.s.stats();
    const el = $("#sprog");
    if (el) el.textContent = `${st.done} done · ${st.remaining} left${st.asked ? ` · ${st.rightPct}%` : ""}`;
    const wb = $("#wrapbtn");
    if (wb) {
      wb.textContent = st.wrapping ? `Wrapping up (${st.active})` : "Wrap up";
      wb.classList.toggle("on", st.wrapping);
    }
  }

  // Repaints the whole question, including an answer already given (when coming back to it).
  function paintSession() {
    paintQuestion();
    const a = sess && sess.s.answer();
    if (a) {
      $("#qin").value = a.text;
      paintAnswer();
    }
  }

  function paintQuestion(keepText) {
    const cur = sess.s.current();
    if (!cur) return finishSession();
    const s = cur.item.entry.subject;
    const card = $("#qcard");
    card.className = `qcard ${TYPE_CLASS[s.object]}`;
    const qc = $("#qchars");
    qc.innerHTML = charsHTML(s);
    qc.dataset.len = glyphLen(s);
    const what = cur.kind === "reading" ? "Reading" : s.object === "radical" ? "Name" : "Meaning";
    const prompt = $("#qprompt");
    prompt.className = `qprompt kind-${cur.kind}`;
    prompt.innerHTML = `${TYPE_NAME[s.object]} <b>${what}</b>`;
    const input = $("#qin");
    const old = input.value;
    imeOn = !!input.dataset.ime;
    setIME(input, cur.kind === "reading");
    input.dataset.ime = imeOn ? "1" : "";
    input.readOnly = false;
    input.className = cur.kind === "reading" ? "ja" : "";
    input.lang = cur.kind === "reading" ? "ja" : "en";
    input.placeholder = cur.kind === "reading" ? "答え" : "Your answer";
    input.value = keepText ? old : "";
    $("#qnote").textContent = "";
    hideConfusions();
    $("#qacts").innerHTML = "";
    $("#qinfo").innerHTML = "";
    infoOpen = false;
    infoAll = false;
    paintProgress();
    input.focus();
    if (keepText) input.select();
  }

  function paintAnswer() {
    const cur = sess.s.current();
    const a = sess.s.answer();
    const s = cur.item.entry.subject;
    const input = $("#qin");
    input.readOnly = true;
    input.classList.toggle("right", a.right);
    input.classList.toggle("wrong", !a.right);
    let note = a.result === "close" && a.right ? a.message : "";
    if (a.changed) note = a.right ? "Marked right." : "Marked wrong.";
    $("#qnote").textContent = note;
    paintConfusions(cur, a);
    const hasAudio = readingShown() && audioFor(s).length;
    const infoLabel = !infoOpen ? "Item info" : sess.s.otherTodo().length && !infoAll ? "Show everything" : "Hide info";
    $("#qacts").innerHTML = `
      <button class="btn small" data-act="retype">Retype <kbd>⌫</kbd></button>
      ${a.right ? `<button class="btn small" data-act="markwrong">Mark wrong <kbd>−</kbd></button>` : `<button class="btn small" data-act="markright">Mark right <kbd>+</kbd></button>`}
      <button class="btn small" data-act="info">${infoLabel} <kbd>F</kbd></button>
      ${hasAudio ? `<button class="btn small" data-act="audio">Audio <kbd>J</kbd></button>` : ""}
      <button class="btn small primary" data-act="next">Next <kbd>↵</kbd></button>`;
    paintInfo();
    input.focus({ preventScroll: true });
  }

  // After a wrong answer: other items whose answer is what you typed (like ConfusionGuesser),
  // on a card that slides in at the top right of the question.
  function paintConfusions(cur, a) {
    const el = $("#qconf");
    if (!el) return;
    const s = cur.item.entry.subject;
    const typed = a.right ? "" : cur.kind === "reading" ? C.normalizeReading(a.text) : C.normalizeMeaning(a.text);
    const list = typed ? I.confusions(model, s, cur.kind, typed, C.normalizeMeaning) : [];
    if (!list.length) return hideConfusions();
    const key = `${s.id}:${list.map((x) => x.id).join(",")}`;
    if (el.classList.contains("show") && el.dataset.key === key) return; // already showing (info toggled, say)
    el.dataset.key = key;
    el.innerHTML = `<div class="qconf-head"><span>You may be thinking of</span><button class="qconf-x" data-act="confclose" aria-label="Close">✕</button></div>${chips(list)}`;
    void el.offsetWidth; // start from the hidden state so the slide runs
    el.classList.add("show");
    const t = $("#toast");
    if (t) t.classList.remove("show"); // the previous item's stage would sit under the card
  }
  // Slides back out the way it came; the content stays until it has gone.
  function hideConfusions() {
    const el = $("#qconf");
    if (el) el.classList.remove("show");
  }

  function paintInfo() {
    const el = $("#qinfo");
    if (!el) return;
    const cur = sess.s.current();
    if (!infoOpen || !cur) {
      el.innerHTML = "";
      return;
    }
    const todo = infoAll ? [] : sess.s.otherTodo();
    const note = todo.length
      ? `<p class="muted small hidden-note">The ${todo[0]} is hidden until you answer it. <button class="link" data-act="infoall">Show everything</button> <kbd>E</kbd></p>`
      : "";
    el.innerHTML = note + infoHTML(cur.item.entry.subject, { hide: { meaning: todo.includes("meaning"), reading: todo.includes("reading") } });
  }

  // Whether the reading may be shown (and its audio played) yet.
  function readingShown() {
    const cur = sess.s.current();
    const s = cur.item.entry.subject;
    return infoAll || cur.kind === "reading" || !s.data.readings || !sess.s.otherTodo().includes("reading");
  }

  // F: info for what has been asked. F again: everything, the half still to answer too
  // (when there is one). F once more: closed. E goes straight to everything, or closes it.
  function cycleInfo() {
    if (!infoOpen) infoOpen = true;
    else if (!infoAll && sess.s.otherTodo().length) infoAll = true;
    else infoOpen = infoAll = false;
    paintAnswer();
  }
  function toggleAll() {
    infoOpen = infoAll = !(infoOpen && infoAll);
    paintAnswer();
  }

  function shake(message) {
    const form = $("#qform");
    form.classList.remove("shake");
    void form.offsetWidth; // restart the animation
    form.classList.add("shake");
    $("#qnote").textContent = message || "";
  }

  function submitAnswer() {
    if (!sess) return;
    if (sess.s.answer()) return next();
    const cur = sess.s.current();
    const r = sess.s.submit($("#qin").value);
    if (!r) return;
    if (!C.counts(r.result)) return shake(r.message);
    const a = sess.s.answer();
    const s = cur.item.entry.subject;
    if (!a.right && settings.infoOnWrong) infoOpen = true;
    paintAnswer();
    if (cur.kind === "reading" && (sess.kind === "lesson" ? settings.lessonAutoplay : settings.autoplay)) play(s, a.right ? C.normalizeReading(a.text) : null);
    if (a.right && a.result === "exact" && settings.lightning) lightningTimer = setTimeout(next, 350);
  }

  function next() {
    clearTimeout(lightningTimer);
    lightningTimer = null;
    if (!sess || !sess.s.answer()) return;
    const f = sess.s.advance();
    if (f) {
      finished(f);
      if (settings.srsIndicator && sess.kind === "reviews") toast(f);
    }
    if (!sess.s.current()) return finishSession();
    paintQuestion();
  }

  function retype() {
    clearTimeout(lightningTimer);
    lightningTimer = null;
    sess.s.retype();
    paintQuestion(true);
  }

  function mark(right) {
    clearTimeout(lightningTimer);
    lightningTimer = null;
    sess.s.mark(right);
    paintAnswer();
  }

  function toast(f) {
    const from = f.entry.assignment.data.srs_stage;
    const to = I.nextStage(from, f.wrongMeaning + f.wrongReading);
    const el = $("#toast");
    if (!el) return;
    el.className = `toast show ${to > from ? "up" : "down"}`;
    el.innerHTML = `<span lang="ja">${charsHTML(f.entry.subject)}</span> ${to > from ? "▲" : "▼"} ${I.STAGE_NAMES[to]}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function finishSession() {
    last = { kind: sess.kind, label: sess.label, done: sess.s.finished(), stats: sess.s.stats() };
    sess = null;
    if (lesson && lesson.phase === "quiz") lesson = null;
    nav("done");
  }

  function quit() {
    if (!sess) return nav("home");
    const st = sess.s.stats();
    if (st.done && sess.kind !== "lesson") {
      last = { kind: sess.kind, label: sess.label, done: sess.s.finished(), stats: st, left: true };
    }
    if (sess.kind === "lesson") {
      // Back to the lesson pages; nothing in this batch has been started unless its quiz was finished.
      sess = null;
      lesson.phase = "teach";
      return nav("lessons");
    }
    nav("home");
  }

  function viewDone() {
    const L = last;
    const missed = L.done.filter((d) => d.wrongMeaning + d.wrongReading);
    const right = L.done.filter((d) => !(d.wrongMeaning + d.wrongReading));
    const pct = L.done.length ? Math.round((100 * right.length) / L.done.length) : 0;
    const now = Date.now();
    const moreReviews = I.reviewsDue(model, now, skipSet()).length;
    const moreLessons = Math.min(I.lessonsAvailable(model, skipSet()).length, I.lessonRoom(model, now, settings));
    const what = L.kind === "lesson" ? "lessons learned" : L.kind === "practice" ? "items practised" : "items reviewed";
    const sent = L.kind === "practice" ? "Practice: nothing was sent." : sending() ? (outboxCount ? `${outboxCount} waiting to send.` : "All sent to WaniKani.") : demo ? "Demo: nothing was sent." : "Test mode: nothing was sent.";
    return `<header class="top"><h1>${esc(L.label)}: done</h1></header>
      <section class="card">
        <p class="hero">${L.done.length}</p>
        <p>${what} · ${pct}% right first time · ${L.stats.rightPct}% of answers right</p>
        <p class="muted small">${sent}</p>
      </section>
      ${missed.length ? `<section class="card"><h2>Missed (${missed.length})</h2>${chips(missed.map((d) => d.entry.subject), (s) => {
        const d = missed.find((x) => x.entry.subject === s);
        return [d.wrongMeaning ? `meaning ×${d.wrongMeaning}` : "", d.wrongReading ? `reading ×${d.wrongReading}` : ""].filter(Boolean).join(", ");
      })}</section>` : ""}
      ${right.length ? `<details class="card"><summary>Right first time (${right.length})</summary>${chips(right.map((d) => d.entry.subject))}</details>` : ""}
      <div class="row">
        <button class="btn" data-act="home">Home</button>
        ${L.kind === "reviews" && moreReviews ? `<button class="btn primary" data-act="reviews">More reviews (${moreReviews})</button>` : ""}
        ${L.kind === "lesson" && moreLessons ? `<button class="btn primary" data-act="lessons">Next lessons (${Math.min(moreLessons, settings.lessonBatch)})</button>` : ""}
      </div>`;
  }

  // ---------- lessons ----------
  function viewLesson() {
    const L = lesson;
    const e = L.batch[L.idx];
    const s = e.subject;
    const lastPage = L.idx === L.batch.length - 1;
    const allSeen = L.seen.size === L.batch.length;
    return `<div class="lesson">
      <header class="sbar">
        <button class="icon" data-act="home" aria-label="Leave lessons" title="Leave. Nothing in this batch is started until its quiz is done.">✕</button>
        <span class="slabel">Lessons</span>
        <span class="sprog">${L.idx + 1} of ${L.batch.length}</span>
        ${allSeen ? `<button class="btn small primary" data-act="lquiz">Quiz</button>` : ""}
      </header>
      ${!sending() ? `<p class="testflag">${demo ? "Demo" : "Test mode"}: nothing is sent</p>` : ""}
      <nav class="ltabs">${L.batch.map((x, i) => `<button class="ltab ${TYPE_CLASS[x.subject.object]} ${i === L.idx ? "on" : ""}" data-act="ltab" data-i="${i}" lang="ja">${charsHTML(x.subject)}</button>`).join("")}</nav>
      <section class="qcard ${TYPE_CLASS[s.object]}"><div class="qchars" lang="ja" data-len="${glyphLen(s)}">${charsHTML(s)}</div>
        <p class="qtype">${TYPE_NAME[s.object]} · level ${s.data.level}</p></section>
      ${infoHTML(s, { lesson: true })}
      <div class="row lnav">
        <button class="btn" data-act="lprev" ${L.idx ? "" : "disabled"}>← Back</button>
        ${lastPage ? `<button class="btn primary" data-act="lquiz">Start the quiz →</button>` : `<button class="btn primary" data-act="lnext">Next →</button>`}
      </div>
      <p class="keys muted small">Keys: ← → move · Enter next · J audio · Q quiz</p>
    </div>`;
  }
  function lessonGo(i) {
    if (!lesson || i < 0 || i >= lesson.batch.length) return;
    lesson.idx = i;
    lesson.seen.add(i);
    render();
    window.scrollTo(0, 0);
    const s = lesson.batch[i].subject;
    if (settings.lessonAutoplay && s.data.pronunciation_audios && s.data.pronunciation_audios.length) play(s);
  }
  function lessonQuiz() {
    lesson.phase = "quiz";
    makeSession("lesson", lesson.batch, "Lesson quiz", { activeSize: lesson.batch.length, strict: false });
    nav("lessons");
  }

  // ---------- item info ----------
  function section(title, body, cls = "") {
    return `<section class="isec ${cls}"><h3>${title}</h3>${body}</section>`;
  }
  function mnemonicHTML(label, text, hint, note) {
    if (!text && !hint && !note) return "";
    return `<div class="mnem"><h4>${label}</h4>${markup(text)}
      ${hint ? `<div class="hint"><b>Hint</b>${markup(hint)}</div>` : ""}
      ${note ? `<div class="note"><b>Your note</b>${markup(note)}</div>` : ""}</div>`;
  }
  function audioButtons(s) {
    return audioFor(s).map((c) => `<button class="btn small" data-act="play" data-id="${s.id}" data-pron="${esc(c.metadata.pronunciation)}">▶ <span lang="ja">${esc(c.metadata.pronunciation)}</span></button>`).join(" ");
  }

  // Everything about a subject. `hide` keeps back what the session has not asked yet.
  function infoHTML(s, { hide = {}, lesson: inLesson = false } = {}) {
    const d = s.data;
    const t = s.object;
    const a = model.bySubject.get(s.id);
    const st = model.stats.get(s.id);
    const sm = model.materials.get(s.id);
    const note = (k) => (sm && !sm.data.hidden ? sm.data[k] : null);
    const out = [];
    if (!hide.meaning) {
      const alts = d.meanings.filter((m) => !m.primary).map((m) => esc(m.meaning));
      const syn = I.synonymsFor(model, s.id).map(esc);
      const pos = (d.parts_of_speech || []).map(esc).join(", ");
      out.push(section(t === "radical" ? "Name" : "Meaning", `
        <p class="ibig">${esc(primaryMeaning(s))}</p>
        ${alts.length ? `<p>Also: ${alts.join(", ")}</p>` : ""}
        ${syn.length ? `<p>Your synonyms: ${syn.join(", ")}</p>` : ""}
        ${pos ? `<p class="muted">${pos}</p>` : ""}
        ${t === "kana_vocabulary" ? `<p>${audioButtons(s)}</p>${slot("pitch", s)}` : ""}
        ${mnemonicHTML("Mnemonic", d.meaning_mnemonic, d.meaning_hint, note("meaning_note"))}`));
    }
    if (!hide.reading && d.readings) {
      let body;
      if (t === "kanji") {
        const col = (type, label) => {
          const rs = d.readings.filter((r) => r.type === type);
          return `<div class="kread"><h4>${label}</h4><p lang="ja">${rs.length ? rs.map((r) => `<span class="${r.accepted_answer ? "acc" : "nacc"}">${esc(r.reading)}</span>`).join("、") : "<span class=\"nacc\">—</span>"}</p></div>`;
        };
        body = `<div class="kreads">${col("onyomi", "On'yomi")}${col("kunyomi", "Kun'yomi")}${col("nanori", "Nanori")}</div>
          <p class="muted small">Bold readings are the ones the quiz accepts.</p>`;
      } else {
        body = `<p class="ibig" lang="ja">${d.readings.map((r) => esc(r.reading)).join("、")}</p><p>${audioButtons(s)}</p>${slot("pitch", s)}`;
      }
      out.push(section("Reading", body + mnemonicHTML("Mnemonic", d.reading_mnemonic, d.reading_hint, note("reading_note"))));
    }
    if (!hide.meaning && d.context_sentences && d.context_sentences.length) {
      out.push(section("Context", d.context_sentences.map((c) => `<p class="ctx"><span lang="ja">${esc(c.ja)}</span><br><span class="muted">${esc(c.en)}</span></p>`).join("")));
    }
    const subj = (ids) => (ids || []).map((id) => model.subjects.get(id)).filter((x) => I.usable(model, x));
    if (t === "kanji") {
      const comps = subj(d.component_subject_ids);
      if (comps.length) out.push(section("Radicals", chips(comps)));
      const sim = I.similarKanji(model, s);
      if (sim.length) out.push(section("Looks similar", chips(sim)));
      const shared = I.sharedRadicals(model, s);
      if (shared.length) {
        const by = new Map(shared.map((h) => [h.subject.id, h.shared.map((r) => esc(primaryMeaning(r))).join(" + ")]));
        out.push(section("Shares radicals", chips(shared.map((h) => h.subject), (k) => `shares ${by.get(k.id)}`)));
      }
      // The sound part gives the reading away, so it waits until the reading is answered.
      if (!hide.reading) out.push(slot("keisei", s));
    }
    if (t === "vocabulary") {
      const comps = subj(d.component_subject_ids);
      if (comps.length) out.push(section("Kanji in this word", chips(comps)));
    }
    if (t === "radical" || t === "kanji") {
      const used = subj(d.amalgamation_subject_ids);
      if (used.length) {
        const shown = used.slice(0, 16);
        out.push(section(t === "radical" ? "Used in these kanji" : "Used in these words", chips(shown) + (used.length > shown.length ? `<p class="muted small">and ${used.length - shown.length} more</p>` : "")));
      }
    }
    if (!inLesson && a && a.data.started_at) {
      const bits = [`${I.STAGE_NAMES[a.data.srs_stage]}`];
      if (a.data.available_at && a.data.srs_stage < 9) {
        const due = Date.parse(a.data.available_at);
        bits.push(due <= Date.now() ? "due now" : `next review ${fmtWhen(due)}`);
      }
      if (st) {
        bits.push(`${st.data.percentage_correct}% right overall`);
        bits.push(`meaning streak ${st.data.meaning_current_streak}`);
        if (d.readings) bits.push(`reading streak ${st.data.reading_current_streak}`);
      }
      out.push(section("Your progress", `<p class="muted">${bits.join(" · ")}</p>`));
    }
    if (d.document_url) out.push(`<p class="small"><a href="${esc(d.document_url)}" target="_blank" rel="noopener">Open on WaniKani ↗</a></p>`);
    return `<div class="info">${out.join("")}</div>`;
  }

  // A stack of item sheets over the current screen.
  function openModal(id) {
    const s = model.subjects.get(Number(id));
    if (!s) return;
    modalStack.push(s.id);
    paintModal();
  }
  function paintModal() {
    let el = $("#modal");
    if (!modalStack.length) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "modal";
      el.className = "modal";
      document.body.appendChild(el);
    }
    const s = model.subjects.get(modalStack[modalStack.length - 1]);
    el.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(primaryMeaning(s))}">
      <header class="sheet-bar">
        ${modalStack.length > 1 ? `<button class="btn small" data-act="mback">← Back</button>` : "<span></span>"}
        <button class="icon" data-act="mclose" aria-label="Close">✕</button>
      </header>
      <section class="qcard small ${TYPE_CLASS[s.object]}"><div class="qchars" lang="ja" data-len="${glyphLen(s)}">${charsHTML(s)}</div>
        <p class="qtype">${TYPE_NAME[s.object]} · level ${s.data.level}</p></section>
      ${infoHTML(s)}
    </div>`;
    el.scrollTop = 0;
  }
  function closeModal() {
    modalStack.length = 0;
    paintModal();
  }


  // ---------- extra data: sound parts and pitch accent ----------
  // From the Kanjium database (CC BY-SA 4.0, see data/LICENSE.md). Fetched the first time an
  // item needs it; until then a placeholder sits in the item info and is filled in place.
  const extra = { keisei: null, pitch: null };
  const extraLoading = {};
  const EXTRA_URL = { keisei: "data/keisei.json", pitch: "data/pitch.tsv" };
  function needExtra(name) {
    if (extra[name] || extraLoading[name]) return;
    extraLoading[name] = fetch(EXTRA_URL[name])
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return name === "keisei" ? r.json() : r.text();
      })
      .then((d) => {
        extra[name] = name === "pitch" ? Pitch.parse(d) : d;
        fillSlots(name);
      })
      .catch(() => {
        extraLoading[name] = null; // try again the next time an item asks
        document.querySelectorAll(`.slot[data-slot="${name}"]`).forEach((el) => el.remove());
      });
  }
  const extraHTML = (name, s) => (name === "pitch" ? pitchHTML(s) : keiseiHTML(s));
  function slot(name, s) {
    if (extra[name]) return extraHTML(name, s);
    needExtra(name);
    return `<div class="slot" data-slot="${name}" data-id="${s.id}"></div>`;
  }
  function fillSlots(name) {
    document.querySelectorAll(`.slot[data-slot="${name}"]`).forEach((el) => {
      const s = model && model.subjects.get(Number(el.dataset.id));
      el.outerHTML = s ? extraHTML(name, s) : "";
    });
  }

  const PITCH_NAME = {
    heiban: "flat, no drop (heiban)",
    atamadaka: "drops after the first mora (atamadaka)",
    nakadaka: "drops inside the word (nakadaka)",
    odaka: "drops after the word (odaka)",
  };
  // One line per reading and pattern: a line over the high morae, a step where it rises or
  // drops, and an empty box for a particle after the word.
  function pitchHTML(s) {
    const kana = s.object === "kana_vocabulary";
    const readings = kana ? [s.data.characters] : (s.data.readings || []).map((r) => r.reading);
    const rows = [];
    for (const r of readings) {
      for (const drop of Pitch.lookup(extra.pitch, s.data.characters, kana ? "" : r)) {
        const mo = Pitch.morae(r);
        const p = Pitch.pattern(mo.length, drop);
        let prev = null;
        const cells = mo.map((m, i) => {
          const h = p.high[i];
          const cls = `mo ${h ? "hi" : "lo"}${prev !== null && prev !== h ? " step" : ""}`;
          prev = h;
          return `<span class="${cls}">${esc(m)}</span>`;
        });
        cells.push(`<span class="mo pt ${p.particle ? "hi" : "lo"}${prev !== p.particle ? " step" : ""}" title="a particle after the word"></span>`);
        rows.push(`<p class="pitch"><span class="pline" lang="ja" role="img" aria-label="${esc(r)}: ${esc(PITCH_NAME[Pitch.kind(mo.length, drop)])}">${cells.join("")}</span>
          <span class="muted small">[${drop}] ${PITCH_NAME[Pitch.kind(mo.length, drop)]}</span></p>`);
      }
    }
    return `<div class="pitches"><h4>Pitch accent</h4>${rows.length ? rows.join("") : `<p class="muted small">Not in the pitch list.</p>`}</div>`;
  }

  // Sound part (keisei): the phonetic component, and other kanji built on it.
  function keiseiHTML(s) {
    const f = I.soundFamily(model, s, extra.keisei, (r) => W.toHiragana(r));
    if (!f) return "";
    const reads = `<span lang="ja">${esc(f.readings.join("、"))}</span>`;
    let lead;
    if (f.isPart) lead = `<p>This kanji is a sound part itself. Kanji built on it are often read ${reads}.</p>`;
    else {
      const what = f.compound ? "A sound-and-meaning kanji: one part hints at the meaning, the other at the sound." : "This kanji has a sound part.";
      const follows = f.shared.length ? `This kanji reads <span lang="ja">${esc(f.shared.join("、"))}</span>, like its sound part.` : "Its on'yomi does not follow the sound part.";
      lead = `<p>${what} The sound part <span class="kpart" lang="ja">${esc(f.part)}</span> is read ${reads}. ${follows}</p>${f.partSubject ? chips([f.partSubject]) : ""}`;
    }
    const shared = new Map(f.family.map((x) => [x.subject.id, x.shared]));
    const fam = f.family.length
      ? `<h4>Other kanji with this sound part</h4>${chips(f.family.map((x) => x.subject), (k) => {
        const r = shared.get(k.id);
        return r.length ? `reads <span lang="ja">${esc(r.join("、"))}</span>` : "reads differently";
      })}`
      : "";
    return section("Sound part", `${lead}${fam}<p class="muted small">From the Kanjium database (CC BY-SA 4.0).</p>`);
  }

  // ---------- items: inspector and self-study ----------
  const STATE_NAME = { locked: "Locked", lesson: "In lessons", apprentice: "Apprentice", guru: "Guru", master: "Master", enlightened: "Enlightened", burned: "Burned" };
  const ROW_LIMIT = 300;
  let itemRows = [];
  const quizable = (rows) => (settings.selfStudyKinds === "reading" ? rows.filter((r) => C.questionsFor(r.subject).includes("reading")) : rows);
  function viewItems() {
    const now = Date.now();
    itemRows = I.inspect(model, settings.inspect, now, history);
    const box = (key, label) => `<label class="tog"><input type="checkbox" data-set="${key}" ${getSetting(key) ? "checked" : ""}> ${label}</label>`;
    const sel = (key, opts, num) => `<select data-set="${key}" ${num ? "data-num" : ""}>${opts.map(([v, l]) => `<option value="${v}" ${String(getSetting(key)) === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const lvl = (key) => `<input type="number" inputmode="numeric" min="1" max="60" data-set="${key}" data-num value="${getSetting(key)}" aria-label="${key.endsWith("from") ? "From level" : "To level"}">`;
    const pool = quizable(itemRows).length;
    const quizN = settings.selfStudyLimit ? Math.min(settings.selfStudyLimit, pool) : pool;
    const rows = itemRows.slice(0, ROW_LIMIT).map((r) => {
      const s = r.subject;
      return `<tr>
        <td><button class="ichar ${TYPE_CLASS[s.object]}" data-act="open" data-id="${s.id}" lang="ja">${charsHTML(s)}</button></td>
        <td>${esc(primaryMeaning(s))}</td>
        <td lang="ja">${esc(primaryReading(s))}</td>
        <td class="num">${s.data.level}</td>
        <td>${r.stage > 0 ? I.STAGE_NAMES[r.stage] : STATE_NAME[r.state]}</td>
        <td class="num">${r.accuracy == null ? "" : `${r.accuracy}%`}</td>
        <td>${r.next ? (r.next <= now ? "now" : fmtWhen(r.next)) : ""}</td>
      </tr>`;
    }).join("");
    return `<header class="top"><h1>Items</h1><nav class="topnav"><a class="btn small" href="#/">Home</a></nav></header>
      <section class="card">
        <div class="field">Levels ${lvl("inspect.from")} to ${lvl("inspect.to")}</div>
        <div class="field">Types ${box("inspect.types.radical", "Radicals")} ${box("inspect.types.kanji", "Kanji")} ${box("inspect.types.vocabulary", "Vocabulary")}</div>
        <div class="field">Stages ${I.STATES.map((k) => box(`inspect.states.${k}`, STATE_NAME[k])).join(" ")}</div>
        <label class="field">Only ${sel("inspect.extra", Object.entries(I.EXTRA_FILTERS))}</label>
        <label class="field">Sort by ${sel("inspect.sort", Object.entries(I.INSPECT_SORTS))}</label>
      </section>
      <section class="card">
        <h2>Self-study quiz <span class="muted small">nothing is sent</span></h2>
        <div class="row">
          <label class="field">Ask ${sel("selfStudyKinds", [["both", "Meaning and reading"], ["meaning", "Meaning only"], ["reading", "Reading only"]])}</label>
          <label class="field">How many ${sel("selfStudyLimit", [[10, "10"], [20, "20"], [50, "50"], [100, "100"], [0, "All"]], true)}</label>
        </div>
        <button class="btn primary" data-act="selfstudy" ${quizN ? "" : "disabled"}>Quiz ${n(quizN)} item${quizN === 1 ? "" : "s"}</button>
        <p class="muted small">Picked at random from the list below. Item info stays hidden until you answer.</p>
      </section>
      <section class="card">
        <h2>${n(itemRows.length)} item${itemRows.length === 1 ? "" : "s"}</h2>
        ${itemRows.length ? `<div class="tablewrap"><table class="itable"><thead><tr><th>Item</th><th>Meaning</th><th>Reading</th><th class="num">Level</th><th>Stage</th><th class="num">Right</th><th>Next review</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">No items match these filters.</p>`}
        ${itemRows.length > ROW_LIMIT ? `<p class="muted small">Showing the first ${ROW_LIMIT}. Narrow the filters to see the rest.</p>` : ""}
      </section>`;
  }
  function startSelfStudy() {
    const kinds = settings.selfStudyKinds === "both" ? null : [settings.selfStudyKinds];
    let rows = I.shuffle(quizable(itemRows));
    if (settings.selfStudyLimit) rows = rows.slice(0, settings.selfStudyLimit);
    if (!rows.length) return;
    const entries = rows.map((r) => (r.assignment ? I.entryOf(model, r.assignment) : { key: `s${r.subject.id}`, subject: r.subject, synonyms: I.synonymsFor(model, r.subject.id), assignment: null }));
    makeSession("practice", entries, "Self-study", kinds ? { kinds } : {});
    nav("quiz");
  }

  // ---------- stats: heatmap, level times, the week ahead ----------
  const plural = (k, v) => `${n(v)} ${v === 1 ? k.replace(/s$/, "") : k}`;
  function heatHTML(byDay, now, key) {
    const today = new Date(I.startOfDay(now));
    const start = new Date(today);
    start.setDate(start.getDate() - 7 * 52 - ((today.getDay() + 6) % 7)); // a Monday, 52 weeks back
    let max = 0;
    for (const v of byDay.values()) max = Math.max(max, v[key]);
    const cells = [];
    const months = [];
    let col = 1;
    for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const v = (byDay.get(d.getTime()) || {})[key] || 0;
      const row = (d.getDay() + 6) % 7;
      if (row === 0 && d.getDate() <= 7) months.push(`<span style="grid-column:${col}">${d.toLocaleDateString([], { month: "short" })}</span>`);
      const tip = `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}: ${plural(key, v)}`;
      const lvl = v ? Math.min(4, Math.ceil((4 * v) / max)) : 0;
      cells.push(`<i class="hm${lvl}" style="grid-row:${row + 1};grid-column:${col}" data-tip="${esc(tip)}"></i>`);
      if (row === 6) col++;
    }
    return `<div class="heat-wrap" id="heatwrap" style="--cols:${col}"><div class="heat-months">${months.join("")}</div>
      <div class="heat" role="img" aria-label="${esc(`${key} per day for the last year`)}">${cells.join("")}</div></div>
      <p class="heat-key muted small"><span id="heattip">Point at a day to see its count.</span><span>Less <i class="hm0"></i><i class="hm1"></i><i class="hm2"></i><i class="hm3"></i><i class="hm4"></i> More</span></p>`;
  }
  function viewStats() {
    const now = Date.now();
    const key = settings.heatmap === "lessons" ? "lessons" : "reviews";
    const byDay = I.activity(model, allHistory || [], now);
    const days = [...byDay.entries()].filter(([, v]) => v[key]);
    const total = days.reduce((t, [, v]) => t + v[key], 0);
    const best = days.reduce((b, d) => (!b || d[1][key] > b[1][key] ? d : b), null);
    const recent = [...Array(14)].map((_, i) => {
      const d = new Date(I.startOfDay(now));
      d.setDate(d.getDate() - i);
      const v = byDay.get(d.getTime()) || { lessons: 0, reviews: 0, missed: 0 };
      return `<tr><td>${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</td><td class="num">${v.reviews}</td><td class="num">${v.reviews ? `${Math.round((100 * (v.reviews - v.missed)) / v.reviews)}%` : ""}</td><td class="num">${v.lessons}</td></tr>`;
    }).join("");

    const lt = I.levelTimes(model, now);
    const past = lt.filter((x) => !x.current);
    const med = I.median(past.map((x) => x.ms));
    const cur = lt.find((x) => x.current);
    const maxMs = Math.max(1, ...lt.map((x) => x.ms));
    const levelRows = lt.slice().reverse().map((x) => `<tr class="${x.current ? "cur" : ""}">
        <td class="num">${x.level}</td>
        <td class="num">${fmtDur(x.ms)}${x.current ? " so far" : ""}</td>
        <td class="ltbar"><span style="width:${Math.max(1, (100 * x.ms) / maxMs)}%"></span></td>
        <td class="muted small">${fmtDate(x.start)}${x.end ? ` to ${fmtDate(x.end)}` : ""}</td>
      </tr>`).join("");

    const week = I.forecastDays(model, now, 7);
    const dueNow = I.reviewsDue(model, now, skipSet()).length;
    const wmax = Math.max(1, ...week.map((b) => b.count));
    const weekRows = week.map((b, i) => `<tr><td>${i ? new Date(b.at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : "Rest of today"}</td>
        <td class="num">${n(b.count)}</td><td class="ltbar"><span style="width:${b.count ? Math.max(1, (100 * b.count) / wmax) : 0}%"></span></td></tr>`).join("");

    return `<header class="top"><h1>Stats</h1><nav class="topnav"><a class="btn small" href="#/">Home</a></nav></header>
      <section class="card">
        <h2>Heatmap</h2>
        <label class="field">Show <select data-set="heatmap"><option value="reviews" ${key === "reviews" ? "selected" : ""}>Reviews done here</option><option value="lessons" ${key === "lessons" ? "selected" : ""}>Lessons, all devices</option></select></label>
        ${heatHTML(byDay, now, key)}
        <p class="spread small">
          <span><b>${plural(key, total)}</b> in the last year</span>
          <span><b>${n(days.length)}</b> day${days.length === 1 ? "" : "s"} with any</span>
          <span><b>${n(I.streak(byDay, now, key))}</b> day streak</span>
          ${best ? `<span>Busiest: <b>${n(best[1][key])}</b> on ${fmtDate(best[0])}</span>` : ""}
        </p>
        <p class="muted small">${key === "reviews" ? "Only reviews done in Kanji Desk in this browser. WaniKani no longer lets apps download your past reviews, so reviews on the site, your phone or another browser are not counted." : "Lessons come from WaniKani, so every device counts."}</p>
        <details class="fc-table"><summary>The last 14 days as a list</summary><table><thead><tr><th>Day</th><th class="num">Reviews</th><th class="num">Right</th><th class="num">Lessons</th></tr></thead><tbody>${recent}</tbody></table></details>
      </section>
      <section class="card">
        <h2>Time on each level</h2>
        ${lt.length ? `<p>${cur ? `Level ${cur.level}: <b>${fmtDur(cur.ms)}</b> so far. ` : ""}${past.length ? `Your middle (median) level took <b>${fmtDur(med)}</b>.` : ""}</p>
        <div class="tablewrap"><table class="lt"><thead><tr><th class="num">Level</th><th class="num">Time</th><th></th><th>Dates</th></tr></thead><tbody>${levelRows}</tbody></table></div>`
          : `<p class="muted">No level history yet. It downloads with the next sync.</p>`}
        <p class="muted small">From when a level unlocked until you passed it. Levels left behind by a reset are not shown.</p>
      </section>
      <section class="card">
        <h2>The week ahead</h2>
        <p>${n(dueNow)} due now, then:</p>
        <div class="tablewrap"><table class="lt"><tbody>${weekRows}</tbody></table></div>
      </section>`;
  }

  // ---------- lesson picker ----------
  function viewPick() {
    const avail = I.orderLessons(I.lessonsAvailable(model, skipSet()), "wk");
    const room = I.lessonRoom(model, Date.now(), settings);
    const ids = new Set(avail.map((e) => e.subject.id));
    for (const id of pickSel) if (!ids.has(id)) pickSel.delete(id);
    const groups = new Map();
    for (const e of avail) {
      const k = e.subject.data.level;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e.subject);
    }
    const tile = (s) => `<button class="ptile ${TYPE_CLASS[s.object]} ${pickSel.has(s.id) ? "on" : ""}" data-act="pickone" data-id="${s.id}" aria-pressed="${pickSel.has(s.id)}" title="${esc(primaryMeaning(s))}"><span lang="ja">${charsHTML(s)}</span><small>${esc(primaryMeaning(s))}</small></button>`;
    const body = [...groups].map(([lvl, list]) => `<section class="card"><h2>Level ${lvl} <button class="link small" data-act="picksel" data-which="level:${lvl}">pick all</button></h2>
      <div class="ptiles">${list.map(tile).join("")}</div></section>`).join("");
    const capNote = Number.isFinite(room) ? ` Your caps allow ${room} right now.` : "";
    return `<header class="top"><h1>Pick lessons</h1><nav class="topnav"><a class="btn small" href="#/">Home</a></nav></header>
      <section class="card">
        <p><b>${pickSel.size}</b> picked of ${avail.length} waiting.${capNote}</p>
        <div class="row">
          <button class="btn small" data-act="picksel" data-which="kanji">All kanji</button>
          <button class="btn small" data-act="picksel" data-which="vocabulary">All vocabulary</button>
          <button class="btn small" data-act="picksel" data-which="radical">All radicals</button>
          <button class="btn small" data-act="picksel" data-which="none">None</button>
        </div>
        <button class="btn primary wide" data-act="pickstart" ${pickSel.size && room ? "" : "disabled"}>Learn these, ${settings.lessonBatch} at a time</button>
        <p class="muted small">Picked items are taught first, in the order shown, then lessons go back to your usual order. ${lessonQueue.length ? `<button class="link" data-act="pickclear">Forget my earlier picks (${lessonQueue.length})</button>` : ""}</p>
      </section>
      ${body || `<p class="muted">No lessons waiting.</p>`}`;
  }
  function pickWhich(which) {
    const avail = I.lessonsAvailable(model, skipSet()).map((e) => e.subject);
    if (which === "none") return pickSel.clear();
    const match = which.startsWith("level:")
      ? (s) => s.data.level === Number(which.slice(6))
      : (s) => (s.object === "kana_vocabulary" ? "vocabulary" : s.object) === which;
    const list = avail.filter(match);
    const all = list.every((s) => pickSel.has(s.id));
    for (const s of list) all ? pickSel.delete(s.id) : pickSel.add(s.id);
  }

  // ---------- search ----------
  let searchQuery = "";
  function viewSearch() {
    return `<header class="top"><h1>Search</h1><nav class="topnav"><a class="btn small" href="#/">Home</a></nav></header>
      <input id="searchin" class="search" type="search" placeholder="漢字, かな, romaji or English" value="${esc(searchQuery)}" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Search">
      <div id="results">${resultsHTML()}</div>`;
  }
  function resultsHTML() {
    if (!searchQuery.trim()) return `<p class="muted">Type to search every subject up to your subscription's level.</p>`;
    const found = I.search(model, searchQuery, (q) => (W.isRomaji(q) ? W.toHiragana(q) : W.toHiragana(q, { passRomaji: true })));
    if (!found.length) return `<p class="muted">Nothing found.</p>`;
    return chips(found, (s) => {
      const st = stageOf(s);
      return `level ${s.data.level} · ${st > 0 ? I.STAGE_NAMES[st] : st === 0 ? "in lessons" : "locked"}`;
    });
  }

  // ---------- settings ----------
  function viewSettings() {
    const sel = (key, opts, num) => `<select data-set="${key}" ${num ? "data-num" : ""}>${opts.map(([v, l]) => `<option value="${v}" ${String(settings[key]) === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const chk = (key, label, sub) => `<label class="tog block"><input type="checkbox" data-set="${key}" ${settings[key] ? "checked" : ""}> <span>${label}${sub ? `<br><span class="muted small">${sub}</span>` : ""}</span></label>`;
    const num = (key, min, max) => `<input type="number" inputmode="numeric" min="${min}" max="${max}" data-set="${key}" data-num value="${settings[key]}">`;
    const u = model.user.data;
    return `<header class="top"><h1>Settings</h1><nav class="topnav"><a class="btn small" href="#/">Home</a></nav></header>
      <section class="card">
        <h2>Sending</h2>
        ${demo ? `<p>This is the demo. Nothing is ever sent. <button class="link" data-act="exitdemo">Leave the demo</button></p>` :
          chk("testMode", "Test mode: check answers but send nothing to WaniKani", "Use it to try the app. Items you answer stay due, so they come back on WaniKani and on your phone.")}
      </section>
      <section class="card">
        <h2>Reviews</h2>
        <label class="field">Order ${sel("reviewOrder", Object.entries(I.REVIEW_ORDERS))}</label>
        <label class="field">How many per session ${sel("reviewLimit", [[0, "All of them"], [10, "10"], [20, "20"], [30, "30"], [50, "50"], [100, "100"]], true)}</label>
        <div class="field">Include
          <label class="tog"><input type="checkbox" data-set="types.radical" ${settings.types.radical ? "checked" : ""}> Radicals</label>
          <label class="tog"><input type="checkbox" data-set="types.kanji" ${settings.types.kanji ? "checked" : ""}> Kanji</label>
          <label class="tog"><input type="checkbox" data-set="types.vocabulary" ${settings.types.vocabulary ? "checked" : ""}> Vocabulary</label>
        </div>
        <label class="field">Ask first ${sel("questionOrder", [["random", "Meaning or reading, at random"], ["meaning", "Meaning first"], ["reading", "Reading first"]])}</label>
        ${chk("backToBack", "Both halves back to back", "Ask an item's meaning and reading one after the other.")}
        <label class="field">Items in play at once ${sel("activeSize", [[1, "1"], [3, "3"], [5, "5"], [10, "10 (like the site)"], [20, "20"]], true)}</label>
        ${chk("lightning", "Lightning mode", "Move on by itself after a right answer. Backspace within a moment still retypes.")}
        ${chk("infoOnWrong", "Show item info after a wrong answer")}
        ${chk("srsIndicator", "Show the new SRS stage when an item is done")}
        ${chk("autoplay", "Play the audio after a reading answer")}
        <label class="field">Voice ${sel("voice", [["female", "Female"], ["male", "Male"]])}</label>
      </section>
      <section class="card">
        <h2>Lessons</h2>
        <label class="field">Batch size ${sel("lessonBatch", [3, 4, 5, 6, 7, 8, 9, 10].map((v) => [v, String(v)]), true)}</label>
        <label class="field">Order ${sel("lessonOrder", Object.entries(I.LESSON_ORDERS))}</label>
        <label class="field">Apprentice cap ${num("apprenticeCap", 0, 999)}<span class="muted small">No lessons while Apprentice items reach this. 0 = no cap.</span></label>
        <label class="field">Lessons per day ${num("dailyCap", 0, 999)}<span class="muted small">Counts lessons started today on any device. 0 = no limit.</span></label>
        ${chk("lessonAutoplay", "Play the audio on vocabulary pages")}
      </section>
      <section class="card">
        <h2>Look</h2>
        <label class="field">Theme ${sel("theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]])}</label>
      </section>
      ${demo ? "" : `<section class="card">
        <h2>Account and data</h2>
        <p>${esc(u.username)} · level ${u.level}${u.subscription && u.subscription.max_level_granted < 60 ? ` · free levels only (up to ${u.subscription.max_level_granted})` : ""}</p>
        <p class="muted small">Token ends in …${esc(token.slice(-4))}. ${statusLine()}</p>
        <div class="row">
          <button class="btn" data-act="sync" ${status.syncing ? "disabled" : ""}>Sync now</button>
          <button class="btn" data-act="redownload">Download everything again</button>
          <button class="btn bad" data-act="signout">Sign out and clear this device</button>
        </div>
        <p class="muted small">Signing out deletes the token and the cached items from this browser. ${outboxCount ? `<b>${outboxCount} answers have not been sent yet and would be lost.</b>` : ""}</p>
      </section>`}
      <footer class="foot muted small">Kanji Desk is an unofficial app. It is not made by, or linked to, WaniKani or Tofugu.</footer>`;
  }

  function setSetting(el) {
    const key = el.dataset.set;
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (el.hasAttribute("data-num")) v = Math.max(0, parseInt(v, 10) || 0);
    if (key === "inspect.from" || key === "inspect.to") v = Math.min(60, Math.max(1, v || 1));
    const path = key.split(".");
    const leaf = path.pop();
    path.reduce((o, k) => o[k], settings)[leaf] = v;
    saveSettings();
    if (key === "theme") applyTheme();
    // Items tried in test mode are still due on WaniKani: offer them again for real.
    if (key === "testMode" && !v) practiced.clear();
    if (["home", "items", "stats"].includes(screenOf()[0])) render();
  }

  // ---------- routing ----------
  function render() {
    if (modalStack.length) closeModal();
    const [screen] = screenOf();
    if (!token && !demo) return paint(viewSetup());
    if (!model || !model.user) return paint(viewLoading());
    switch (screen) {
      case "quiz":
        if (!sess) return nav("home");
        paint(viewSession());
        return paintSession();
      case "lessons":
        if (!lesson) return nav("home");
        if (lesson.phase === "quiz" && sess) {
          paint(viewSession());
          return paintSession();
        }
        return paint(viewLesson());
      case "done":
        if (!last) return nav("home");
        return paint(viewDone());
      case "search":
        paint(viewSearch());
        $("#searchin").focus();
        return;
      case "settings":
        return paint(viewSettings());
      case "items":
        return paint(viewItems());
      case "pick":
        return paint(viewPick());
      case "stats":
        if (!allHistory) {
          paint(`<header class="top"><h1>Stats</h1><nav class="topnav"><a class="btn small" href="#/">Home</a></nav></header><p class="muted">Loading…</p>`);
          store.getAll("history").catch(() => []).then((h) => {
            allHistory = h;
            if (screenOf()[0] === "stats") render();
          });
          return;
        }
        paint(viewStats());
        $("#heatwrap").scrollLeft = 1e6; // the latest weeks, on a narrow screen
        return;
      default:
        return paint(viewHome());
    }
  }

  // ---------- events ----------
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) {
      if (e.target.id === "modal") closeModal();
      return;
    }
    const act = t.dataset.act;
    switch (act) {
      case "demo":
        demo = true;
        sessionStorage.setItem(KEYS.demo, "1");
        await openData();
        break;
      case "exitdemo":
        demo = false;
        sessionStorage.removeItem(KEYS.demo);
        model = null;
        sess = null;
        lesson = null;
        practiced.clear();
        if (token) await openData();
        else nav("home");
        break;
      case "home":
        if (lesson && screenOf()[0] === "lessons") lesson = null;
        nav("home");
        break;
      case "sync":
        syncNow();
        paintStatus();
        break;
      case "reviews":
        startReviews();
        break;
      case "lessons":
        startLessons();
        break;
      case "practice":
        startPractice(t.dataset.which);
        break;
      case "resume":
        nav("quiz");
        break;
      case "clearrejected":
        rejected = [];
        save(KEYS.rejected, rejected);
        render();
        break;
      case "quit":
        quit();
        break;
      case "wrap":
        if (sess) {
          sess.s.wrapUp(!sess.s.stats().wrapping);
          paintProgress();
          $("#qin").focus();
        }
        break;
      case "retype":
        retype();
        break;
      case "markright":
        mark(true);
        break;
      case "markwrong":
        mark(false);
        break;
      case "info":
        cycleInfo();
        break;
      case "infoall":
        toggleAll();
        break;
      case "confclose":
        hideConfusions();
        break;
      case "audio":
        if (sess && sess.s.current()) play(sess.s.current().item.entry.subject);
        break;
      case "next":
        next();
        break;
      case "play":
        play(model.subjects.get(Number(t.dataset.id)), t.dataset.pron);
        break;
      case "open":
        openModal(t.dataset.id);
        break;
      case "mback":
        modalStack.pop();
        paintModal();
        break;
      case "mclose":
        closeModal();
        break;
      case "ltab":
        lessonGo(Number(t.dataset.i));
        break;
      case "lnext":
        lessonGo(lesson.idx + 1);
        break;
      case "lprev":
        lessonGo(lesson.idx - 1);
        break;
      case "lquiz":
        lessonQuiz();
        break;
      case "selfstudy":
        startSelfStudy();
        break;
      case "pickone": {
        const id = Number(t.dataset.id);
        pickSel.has(id) ? pickSel.delete(id) : pickSel.add(id);
        render();
        break;
      }
      case "picksel":
        pickWhich(t.dataset.which);
        render();
        break;
      case "pickclear":
        lessonQueue = [];
        render();
        break;
      case "pickstart": {
        const avail = I.orderLessons(I.lessonsAvailable(model, skipSet()), "wk");
        lessonQueue = avail.map((e) => e.subject.id).filter((id) => pickSel.has(id));
        pickSel.clear();
        startLessons();
        break;
      }
      case "redownload":
        if (!confirm("Download all your WaniKani data again? It takes a minute or two.")) return;
        for (const name of WK.COLLECTIONS) await store.setMeta(`updated.${name}`, null);
        syncNow();
        break;
      case "signout":
        if (!confirm(outboxCount ? `${outboxCount} answers have not been sent and will be lost. Sign out anyway?` : "Sign out and clear this device?")) return;
        forgetToken();
        if (store) await store.wipe();
        model = null;
        sess = null;
        lesson = null;
        lessonQueue = [];
        allHistory = null;
        nav("home");
        break;
    }
  });

  document.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "qform") submitAnswer();
    else if (e.target.id === "tokenform") connect($("#tokenin").value);
  });

  document.addEventListener("change", (e) => {
    if (e.target.dataset && e.target.dataset.set) setSetting(e.target);
  });

  // The heatmap's day under the pointer (or tapped), in one line under the grid.
  document.addEventListener("mouseover", (e) => {
    const tip = e.target.matches && e.target.matches(".heat i") && $("#heattip");
    if (tip) tip.textContent = e.target.dataset.tip;
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "searchin") {
      searchQuery = e.target.value;
      $("#results").innerHTML = resultsHTML();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (modalStack.length) {
      if (e.key === "Escape") closeModal();
      return;
    }
    const [screen] = screenOf();
    const quizOn = sess && (screen === "quiz" || (screen === "lessons" && lesson && lesson.phase === "quiz"));
    if (quizOn && sess.s.answer()) {
      const k = e.key;
      if (k === "Enter") next();
      else if (k === "Backspace" || k === "Escape" || k === "Delete") retype();
      else if (k === "+" || k === "=") mark(true);
      else if (k === "-" || k === "_") mark(false);
      else if (k === "f" || k === "F") cycleInfo();
      else if (k === "e" || k === "E") toggleAll();
      else if (k === "j" || k === "J") {
        if (readingShown()) play(sess.s.current().item.entry.subject);
      }
      else return;
      e.preventDefault();
      return;
    }
    if (screen === "lessons" && lesson && lesson.phase === "teach") {
      const k = e.key;
      if (k === "ArrowRight" || k === "Enter") {
        if (lesson.idx === lesson.batch.length - 1) lessonQuiz();
        else lessonGo(lesson.idx + 1);
      } else if (k === "ArrowLeft") lessonGo(lesson.idx - 1);
      else if (k === "j" || k === "J") play(lesson.batch[lesson.idx].subject);
      else if (k === "q" || k === "Q") lessonQuiz();
      else return;
      e.preventDefault();
    }
  });

  window.addEventListener("hashchange", () => render());
  window.addEventListener("online", () => {
    flushNow();
    if (screenOf()[0] === "home") syncNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !model || demo) return;
    flushNow();
    if (Date.now() - status.lastSync > 5 * MIN && screenOf()[0] === "home") syncNow();
  });
  // Reviews arrive on the hour: keep the home counts fresh, and retry anything still queued.
  setInterval(() => {
    if (!model) return;
    if (outboxCount) flushNow();
    if (screenOf()[0] === "home" && !modalStack.length && document.visibilityState === "visible") {
      if (!demo && Date.now() - status.lastSync > 15 * MIN) syncNow();
      else render();
    }
  }, MIN);

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  applyTheme();
  if (token || demo) openData().catch((e) => {
    setupError = `Could not open local storage: ${e.message}`;
    forgetToken();
    render();
  });
  else render();
})();
