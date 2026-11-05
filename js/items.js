// Queues, ordering, related items and dashboard numbers. Pure functions, no DOM, so they run
// in node tests too.
//
// Everything reads from one `model`, built by the app from the cached API data:
//   { user, subjects: Map(id -> subject), assignments: Map(id -> assignment),
//     bySubject: Map(subjectId -> assignment), stats: Map(subjectId -> review_statistic),
//     materials: Map(subjectId -> study_material), levels: Map(level -> level_progression),
//     index: lookups built on first use (per meaning normaliser), dropped when subjects change }
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Items = api;
})(typeof self !== "undefined" ? self : this, function () {
  const STAGE_NAMES = ["Lesson", "Apprentice I", "Apprentice II", "Apprentice III", "Apprentice IV", "Guru I", "Guru II", "Master", "Enlightened", "Burned"];
  const stageGroup = (s) => (s === 0 ? "lesson" : s <= 4 ? "apprentice" : s <= 6 ? "guru" : s === 7 ? "master" : s === 8 ? "enlightened" : "burned");
  // Hours until the next review, by stage (the standard WaniKani intervals).
  const INTERVAL_HOURS = [0, 4, 8, 23, 47, 167, 335, 719, 2879];
  const TYPE_RANK = { radical: 0, kanji: 1, vocabulary: 2, kana_vocabulary: 2 };
  const HOUR = 3600e3;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, rng = Math.random) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Puts fresh API records (one collection's worth) into the model.
  function apply(m, name, items) {
    for (const it of items) {
      if (name === "subjects") m.subjects.set(it.id, it);
      else if (name === "assignments") {
        m.assignments.set(it.id, it);
        m.bySubject.set(it.data.subject_id, it);
      } else if (name === "review_statistics") m.stats.set(it.data.subject_id, it);
      else if (name === "study_materials") m.materials.set(it.data.subject_id, it);
      else if (name === "level_progressions" && newerLevel(m.levels.get(it.data.level), it)) m.levels.set(it.data.level, it);
    }
    if (name === "subjects") m.index = null;
  }
  // A reset leaves the old progression marked abandoned; the live one wins, then the newest.
  function newerLevel(old, p) {
    if (!old || old.id === p.id) return true;
    if (!!old.data.abandoned_at !== !!p.data.abandoned_at) return !!old.data.abandoned_at;
    return (p.data.created_at || "") > (old.data.created_at || "");
  }

  function buildModel({ user, subjects = [], assignments = [], review_statistics = [], study_materials = [], level_progressions = [] }) {
    const m = { user, subjects: new Map(), assignments: new Map(), bySubject: new Map(), stats: new Map(), materials: new Map(), levels: new Map(), index: null };
    apply(m, "subjects", subjects);
    apply(m, "assignments", assignments);
    apply(m, "review_statistics", review_statistics);
    apply(m, "study_materials", study_materials);
    apply(m, "level_progressions", level_progressions);
    return m;
  }

  const maxLevel = (m) => (m.user && m.user.data.subscription && m.user.data.subscription.max_level_granted) || 60;
  const usable = (m, s) => !!s && !s.data.hidden_at && s.data.level <= maxLevel(m);
  const synonymsFor = (m, sid) => {
    const sm = m.materials.get(sid);
    return sm && !sm.data.hidden ? sm.data.meaning_synonyms || [] : [];
  };
  const entryOf = (m, a) => ({ key: a.id, assignment: a, subject: m.subjects.get(a.data.subject_id), synonyms: synonymsFor(m, a.data.subject_id) });

  // Reviews due now. `skip` holds assignment ids already answered and waiting to be sent.
  function reviewsDue(m, now, skip = new Set()) {
    const out = [];
    for (const a of m.assignments.values()) {
      const d = a.data;
      if (d.hidden || !d.started_at || d.srs_stage < 1 || d.srs_stage > 8 || !d.available_at) continue;
      if (Date.parse(d.available_at) > now || skip.has(a.id)) continue;
      if (!usable(m, m.subjects.get(d.subject_id))) continue;
      out.push(entryOf(m, a));
    }
    return out;
  }

  function lessonsAvailable(m, skip = new Set()) {
    const out = [];
    for (const a of m.assignments.values()) {
      const d = a.data;
      if (d.hidden || d.srs_stage !== 0 || !d.unlocked_at || d.started_at || skip.has(a.id)) continue;
      if (!usable(m, m.subjects.get(d.subject_id))) continue;
      out.push(entryOf(m, a));
    }
    return out;
  }

  // How far past due an item is, in units of its own interval (1 = one whole interval late).
  function overdue(entry, now) {
    const d = entry.assignment.data;
    const hours = INTERVAL_HOURS[d.srs_stage] || 1;
    return (now - Date.parse(d.available_at)) / (hours * HOUR);
  }

  const REVIEW_ORDERS = {
    random: "Shuffled",
    "level-asc": "Lower levels first",
    "level-desc": "Higher levels first",
    "current-level": "Current level first",
    "srs-asc": "Lowest SRS stage first",
    "srs-desc": "Highest SRS stage first",
    type: "Radicals, then kanji, then vocabulary",
    overdue: "Most overdue first",
    oldest: "Waiting longest first",
  };

  // Shuffle first, then a stable sort, so ties come in random order.
  function orderReviews(entries, order, { rng = Math.random, now = Date.now(), level = 0 } = {}) {
    const a = shuffle(entries, rng);
    const lvl = (e) => e.subject.data.level;
    const srs = (e) => e.assignment.data.srs_stage;
    const by = {
      "level-asc": (x, y) => lvl(x) - lvl(y),
      "level-desc": (x, y) => lvl(y) - lvl(x),
      "current-level": (x, y) => (lvl(y) === level) - (lvl(x) === level),
      "srs-asc": (x, y) => srs(x) - srs(y),
      "srs-desc": (x, y) => srs(y) - srs(x),
      type: (x, y) => TYPE_RANK[x.subject.object] - TYPE_RANK[y.subject.object],
      overdue: (x, y) => overdue(y, now) - overdue(x, now),
      oldest: (x, y) => Date.parse(x.assignment.data.available_at) - Date.parse(y.assignment.data.available_at),
    }[order];
    return by ? a.sort(by) : a;
  }

  // types: { radical, kanji, vocabulary } booleans (kana vocabulary follows vocabulary). limit: 0 = all.
  function filterReviews(entries, { types, limit } = {}) {
    let out = entries;
    if (types) out = out.filter((e) => types[e.subject.object === "kana_vocabulary" ? "vocabulary" : e.subject.object] !== false);
    if (limit > 0) out = out.slice(0, limit);
    return out;
  }

  const LESSON_ORDERS = {
    wk: "Level, then radicals, kanji, vocabulary",
    "kanji-first": "Kanji first",
    shuffled: "Shuffled",
  };

  function orderLessons(entries, order, rng = Math.random) {
    if (order === "shuffled") return shuffle(entries, rng);
    const rank = order === "kanji-first" ? { kanji: 0, radical: 1, vocabulary: 2, kana_vocabulary: 2 } : TYPE_RANK;
    const key = (e) => [order === "kanji-first" ? rank[e.subject.object] : 0, e.subject.data.level, rank[e.subject.object], e.subject.data.lesson_position];
    return entries.slice().sort((x, y) => {
      const a = key(x), b = key(y);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    });
  }

  const startOfDay = (now) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  function counts(m, now) {
    const c = { apprentice: 0, guru: 0, master: 0, enlightened: 0, burned: 0, lessonsToday: 0 };
    const today = startOfDay(now);
    for (const a of m.assignments.values()) {
      const d = a.data;
      if (d.hidden || !d.started_at) continue;
      c[stageGroup(d.srs_stage)]++;
      if (Date.parse(d.started_at) >= today) c.lessonsToday++;
    }
    return c;
  }

  // How many lessons the caps leave room for. 0 in a cap means no cap.
  function lessonRoom(m, now, { apprenticeCap = 0, dailyCap = 0 } = {}) {
    const c = counts(m, now);
    let room = Infinity;
    if (apprenticeCap > 0) room = Math.min(room, apprenticeCap - c.apprentice);
    if (dailyCap > 0) room = Math.min(room, dailyCap - c.lessonsToday);
    return Math.max(0, room);
  }

  // Reviews coming up, one bucket per clock hour. The first bucket runs from now to the next full hour.
  function forecast(m, now, hours = 24, skip = new Set()) {
    const first = new Date(now);
    first.setMinutes(0, 0, 0);
    const buckets = Array.from({ length: hours }, (_, i) => ({ at: first.getTime() + (i + 1) * HOUR, count: 0 }));
    const end = buckets[buckets.length - 1].at;
    for (const a of m.assignments.values()) {
      const d = a.data;
      if (d.hidden || !d.started_at || !d.available_at || d.srs_stage < 1 || d.srs_stage > 8 || skip.has(a.id)) continue;
      const t = Date.parse(d.available_at);
      if (t <= now || t > end || !usable(m, m.subjects.get(d.subject_id))) continue;
      const i = Math.max(0, Math.ceil((t - first.getTime()) / HOUR) - 1);
      buckets[i].count++;
    }
    return buckets;
  }

  // Kanji at your level that have reached Guru, and how many you need (90%) to level up.
  function levelProgress(m) {
    const level = m.user ? m.user.data.level : 1;
    let total = 0, passed = 0;
    for (const s of m.subjects.values()) {
      if (s.object !== "kanji" || s.data.level !== level || s.data.hidden_at) continue;
      total++;
      const a = m.bySubject.get(s.id);
      if (a && (a.data.passed_at || a.data.srs_stage >= 5)) passed++;
    }
    return { level, total, passed, need: Math.ceil(total * 0.9) };
  }

  // The stage an item lands on after a review, by the WaniKani rule.
  function nextStage(stage, incorrect) {
    if (!incorrect) return Math.min(stage + 1, 9);
    const penalty = stage >= 5 ? 2 : 1;
    return Math.max(1, stage - Math.ceil(incorrect / 2) * penalty);
  }

  const learned = (m, id) => {
    const a = m.bySubject.get(id);
    return !!(a && a.data.started_at);
  };

  function similarKanji(m, subject) {
    return (subject.data.visually_similar_subject_ids || []).map((id) => m.subjects.get(id)).filter((s) => usable(m, s));
  }

  // Other kanji built from the same radicals, most shared first. Each result:
  // { subject, shared: [radical subjects] }.
  function sharedRadicals(m, subject, limit = 12) {
    const comps = subject.data.component_subject_ids || [];
    const hits = new Map();
    for (const rid of comps) {
      const radical = m.subjects.get(rid);
      if (!radical) continue;
      for (const kid of radical.data.amalgamation_subject_ids || []) {
        if (kid === subject.id) continue;
        const k = m.subjects.get(kid);
        if (!k || k.object !== "kanji" || !usable(m, k)) continue;
        if (!hits.has(kid)) hits.set(kid, { subject: k, shared: [] });
        hits.get(kid).shared.push(radical);
      }
    }
    const union = (h) => comps.length + (h.subject.data.component_subject_ids || []).length - h.shared.length;
    return [...hits.values()]
      .sort((x, y) => y.shared.length - x.shared.length || y.shared.length / union(y) - x.shared.length / union(x)
        || learned(m, y.subject.id) - learned(m, x.subject.id) || x.subject.data.level - y.subject.data.level)
      .slice(0, limit);
  }

  // Items you keep missing: misses divided by (current streak ^ 1.5), worst half counts.
  // A score of 1 or more is a leech.
  const hasReading = (s) => s.object === "kanji" || s.object === "vocabulary";
  function leechScore(s, st) {
    if (!st) return 0;
    const d = st.data;
    const half = (wrong, streak) => wrong / Math.pow(Math.max(1, streak), 1.5);
    return Math.max(half(d.meaning_incorrect, d.meaning_current_streak), hasReading(s) ? half(d.reading_incorrect, d.reading_current_streak) : 0);
  }
  function leeches(m, limit = 30) {
    const out = [];
    for (const st of m.stats.values()) {
      const d = st.data;
      if (d.hidden) continue;
      const a = m.bySubject.get(d.subject_id);
      if (!a || a.data.hidden || !a.data.started_at || a.data.srs_stage >= 9) continue;
      const s = m.subjects.get(d.subject_id);
      if (!usable(m, s)) continue;
      const score = leechScore(s, st);
      if (score >= 1) out.push({ entry: entryOf(m, a), score });
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit);
  }

  // Items missed in the last `hours`, from this device's history (newest first, no repeats).
  function recentMistakes(m, history, now, hours = 24) {
    const seen = new Set();
    const out = [];
    for (const h of history.slice().sort((x, y) => y.at - x.at)) {
      if (h.at < now - hours * HOUR || h.mode === "practice" || !(h.wrongMeaning + h.wrongReading) || seen.has(h.subjectId)) continue;
      seen.add(h.subjectId);
      const a = m.bySubject.get(h.subjectId);
      const s = m.subjects.get(h.subjectId);
      if (a && usable(m, s)) out.push(entryOf(m, a));
    }
    return out;
  }

  // Search by characters, kana reading or English meaning. `toKana` turns romaji into kana.
  function search(m, query, toKana, limit = 60) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const kana = toKana ? toKana(q) : q;
    const scored = [];
    for (const s of m.subjects.values()) {
      if (!usable(m, s)) continue;
      const d = s.data;
      let score = 0;
      if (d.characters && d.characters === query.trim()) score = 100;
      else if (d.characters && d.characters.includes(query.trim())) score = 60;
      const meanings = (d.meanings || []).map((x) => x.meaning.toLowerCase()).concat(synonymsFor(m, s.id).map((x) => x.toLowerCase()));
      if (meanings.includes(q)) score = Math.max(score, 90);
      else if (meanings.some((x) => x.split(/\s+/).includes(q))) score = Math.max(score, 70);
      else if (q.length >= 3 && meanings.some((x) => x.startsWith(q))) score = Math.max(score, 50);
      const readings = (d.readings || []).map((x) => x.reading);
      if (kana && readings.includes(kana)) score = Math.max(score, 80);
      else if (kana && kana.length >= 2 && readings.some((x) => x.startsWith(kana))) score = Math.max(score, 40);
      if (score) scored.push({ s, score });
    }
    return scored
      .sort((x, y) => y.score - x.score || x.s.data.level - y.s.data.level || TYPE_RANK[x.s.object] - TYPE_RANK[y.s.object])
      .slice(0, limit)
      .map((x) => x.s);
  }

  // ---------- lookups built once per set of subjects ----------
  // meaning (normalised by the caller's `norm`) -> subjects, reading (kana) -> subjects,
  // characters -> kanji.
  function indexOf(m, norm) {
    if (!m.index) m.index = new Map();
    if (m.index.has(norm)) return m.index.get(norm);
    const ix = { meaning: new Map(), reading: new Map(), kanji: new Map() };
    const add = (map, key, s) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(s)) map.get(key).push(s);
    };
    for (const s of m.subjects.values()) {
      if (!usable(m, s)) continue;
      for (const x of s.data.meanings || []) add(ix.meaning, norm(x.meaning), s);
      for (const x of s.data.auxiliary_meanings || []) if (x.type === "whitelist") add(ix.meaning, norm(x.meaning), s);
      for (const x of s.data.readings || []) add(ix.reading, x.reading, s);
      if (s.object === "kana_vocabulary") add(ix.reading, s.data.characters, s);
      if (s.object === "kanji" && s.data.characters) ix.kanji.set(s.data.characters, s);
    }
    m.index.set(norm, ix);
    return ix;
  }
  const ident = (x) => String(x || "").trim().toLowerCase();

  // After a wrong answer: other items whose answer is what you typed, so you can see what you
  // mixed it up with. `text` is already normalised: `norm(meaning)` or the reading in kana.
  // Only items you have learned or could have (up to your level). Look-alikes first, then
  // items that share a part, then the rest by level.
  function confusions(m, subject, kind, text, norm = ident, limit = 4) {
    if (!text) return [];
    const ix = indexOf(m, norm);
    const hits = ((kind === "reading" ? ix.reading : ix.meaning).get(text) || []).filter((s) => s.id !== subject.id);
    const level = m.user ? m.user.data.level : 60;
    const alike = new Set(subject.data.visually_similar_subject_ids || []);
    const parts = new Set([...(subject.data.component_subject_ids || []), ...(subject.data.amalgamation_subject_ids || [])]);
    const rank = (s) => (alike.has(s.id) ? 0 : parts.has(s.id) ? 1 : s.object === subject.object ? 2 : 3);
    return hits
      .filter((s) => learned(m, s.id) || s.data.level <= level)
      .sort((x, y) => rank(x) - rank(y) || learned(m, y.id) - learned(m, x.id) || x.data.level - y.data.level)
      .slice(0, limit);
  }

  // Sound parts (keisei): `data` is data/keisei.json. For a kanji with a phonetic component,
  // the component, its readings, whether this kanji is a sound-plus-meaning compound, and the
  // other WaniKani kanji built on the same component, each with the readings it shares.
  function soundFamily(m, subject, data, toHira = (x) => x) {
    if (!data || subject.object !== "kanji") return null;
    const row = data.kanji[subject.data.characters];
    if (!row) return null;
    const [part, kind] = row;
    const ph = data.phonetics[part];
    if (!ph) return null;
    const ix = indexOf(m, ident);
    const readings = ph[0];
    const onyomi = (s) => (s.data.readings || []).filter((r) => r.type === "onyomi").map((r) => toHira(r.reading));
    const family = [];
    for (const [ch, r] of Object.entries(data.kanji)) {
      if (r[0] !== part || ch === subject.data.characters) continue;
      const s = ix.kanji.get(ch);
      if (s) family.push({ subject: s, shared: onyomi(s).filter((x) => readings.includes(x)) });
    }
    family.sort((x, y) => (y.shared.length > 0) - (x.shared.length > 0) || learned(m, y.subject.id) - learned(m, x.subject.id) || x.subject.data.level - y.subject.data.level);
    return {
      part,
      partSubject: part === subject.data.characters ? null : ix.kanji.get(part) || null,
      readings,
      single: ph[1] === "s",
      compound: kind === "ps",
      isPart: part === subject.data.characters,
      shared: onyomi(subject).filter((x) => readings.includes(x)),
      family,
    };
  }

  // ---------- item inspector ----------
  const STATES = ["locked", "lesson", "apprentice", "guru", "master", "enlightened", "burned"];
  function stateOf(m, s) {
    const a = m.bySubject.get(s.id);
    if (!a || !a.data.unlocked_at) return "locked";
    if (!a.data.started_at) return "lesson";
    return stageGroup(a.data.srs_stage);
  }
  const EXTRA_FILTERS = {
    none: "Nothing extra",
    leeches: "Leeches",
    "missed-last": "Missed last time",
    "recent-lessons": "Learned in the last 7 days",
    "due-today": "Due in the next 24 hours",
    "recent-mistakes": "Missed in the last 24 hours on this device",
  };
  const INSPECT_SORTS = {
    level: "Level",
    stage: "SRS stage",
    accuracy: "Worst accuracy first",
    leech: "Worst leech first",
    next: "Next review soonest",
    learned: "Learned most recently",
  };

  // Every usable subject that passes the filters, as rows for a table:
  // { subject, assignment, state, stage, accuracy, leech, next }.
  // f: { from, to, types: { radical, kanji, vocabulary }, states: { locked, lesson, ... },
  //      extra: a key of EXTRA_FILTERS, sort: a key of INSPECT_SORTS }
  function inspect(m, f, now, history = []) {
    const from = f.from || 1, to = f.to || 60;
    const day = 24 * HOUR;
    const missedHere = f.extra === "recent-mistakes" ? new Set(recentMistakes(m, history, now).map((e) => e.subject.id)) : null;
    const out = [];
    for (const s of m.subjects.values()) {
      if (!usable(m, s) || s.data.level < from || s.data.level > to) continue;
      const type = s.object === "kana_vocabulary" ? "vocabulary" : s.object;
      if (f.types && f.types[type] === false) continue;
      const state = stateOf(m, s);
      if (f.states && f.states[state] === false) continue;
      const a = m.bySubject.get(s.id) || null;
      const st = m.stats.get(s.id);
      const leech = leechScore(s, st);
      const next = a && a.data.started_at && a.data.available_at && a.data.srs_stage < 9 ? Date.parse(a.data.available_at) : null;
      const started = a && a.data.started_at ? Date.parse(a.data.started_at) : null;
      if (f.extra === "leeches" && (leech < 1 || state === "burned")) continue;
      if (f.extra === "missed-last") {
        const d = st && st.data;
        const missed = d && ((d.meaning_current_streak <= 1 && d.meaning_incorrect > 0) || (hasReading(s) && d.reading_current_streak <= 1 && d.reading_incorrect > 0));
        if (!missed || state === "burned") continue;
      }
      if (f.extra === "recent-lessons" && !(started && started >= now - 7 * day)) continue;
      if (f.extra === "due-today" && !(next && next <= now + day)) continue;
      if (missedHere && !missedHere.has(s.id)) continue;
      out.push({ subject: s, assignment: a, state, stage: a && a.data.started_at ? a.data.srs_stage : -1, accuracy: st ? st.data.percentage_correct : null, leech, next, started });
    }
    const lvl = (x, y) => x.subject.data.level - y.subject.data.level || TYPE_RANK[x.subject.object] - TYPE_RANK[y.subject.object] || (x.subject.data.lesson_position || 0) - (y.subject.data.lesson_position || 0);
    const missingLast = (v) => (v == null ? Infinity : v);
    const by = {
      level: lvl,
      stage: (x, y) => y.stage - x.stage || lvl(x, y),
      accuracy: (x, y) => missingLast(x.accuracy) - missingLast(y.accuracy) || lvl(x, y),
      leech: (x, y) => y.leech - x.leech || lvl(x, y),
      next: (x, y) => missingLast(x.next) - missingLast(y.next) || lvl(x, y),
      learned: (x, y) => (y.started || 0) - (x.started || 0) || lvl(x, y),
    }[f.sort] || lvl;
    return out.sort(by);
  }

  // ---------- heatmap and level times ----------
  // Counts per local day: lessons from WaniKani (every device), reviews from this device's log.
  // Returns Map(dayStart ms -> { lessons, reviews, missed }).
  function activity(m, history, now, days = 371) {
    const first = startOfDay(now - (days - 1) * 24 * HOUR);
    const out = new Map();
    const bump = (t, key) => {
      if (!(t >= first) || t > now) return;
      const d = startOfDay(t);
      if (!out.has(d)) out.set(d, { lessons: 0, reviews: 0, missed: 0 });
      out.get(d)[key]++;
    };
    for (const a of m.assignments.values()) if (a.data.started_at) bump(Date.parse(a.data.started_at), "lessons");
    for (const h of history) {
      if (h.mode !== "reviews") continue;
      bump(h.at, "reviews");
      if (h.wrongMeaning + h.wrongReading) bump(h.at, "missed");
    }
    return out;
  }

  // Days in a row with at least one of `key`, ending today (or yesterday, if today is still empty).
  function streak(byDay, now, key) {
    let d = startOfDay(now);
    if (!(byDay.get(d) || {})[key]) d = startOfDay(d - 12 * HOUR);
    let n = 0;
    while ((byDay.get(d) || {})[key]) {
      n++;
      d = startOfDay(d - 12 * HOUR);
    }
    return n;
  }

  // Reviews arriving per day, from today. Today counts from now (what is due now is not included).
  function forecastDays(m, now, days = 7) {
    const out = [];
    let start = startOfDay(now);
    for (let i = 0; i < days; i++) {
      const end = startOfDay(start + 36 * HOUR);
      out.push({ at: start, end, count: 0 });
      start = end;
    }
    for (const a of m.assignments.values()) {
      const d = a.data;
      if (d.hidden || !d.started_at || !d.available_at || d.srs_stage < 1 || d.srs_stage > 8) continue;
      const t = Date.parse(d.available_at);
      if (t <= now || !usable(m, m.subjects.get(d.subject_id))) continue;
      const b = out.find((x) => t >= x.at && t < x.end);
      if (b) b.count++;
    }
    return out;
  }

  // Time spent on each level, from /level_progressions: unlocked until passed (or until now
  // for the level you are on). [{ level, start, end, ms, current }]
  function levelTimes(m, now) {
    const out = [];
    for (const p of [...m.levels.values()].sort((a, b) => a.data.level - b.data.level)) {
      const d = p.data;
      if (d.abandoned_at || !d.unlocked_at) continue;
      const start = Date.parse(d.unlocked_at);
      const end = d.passed_at ? Date.parse(d.passed_at) : null;
      out.push({ level: d.level, start, end, ms: (end || now) - start, current: !end });
    }
    return out;
  }
  function median(xs) {
    if (!xs.length) return 0;
    const a = xs.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  return {
    STAGE_NAMES, stageGroup, INTERVAL_HOURS, REVIEW_ORDERS, LESSON_ORDERS, HOUR,
    mulberry32, shuffle, apply, buildModel, usable, synonymsFor, entryOf,
    reviewsDue, lessonsAvailable, overdue, orderReviews, filterReviews, orderLessons,
    startOfDay, counts, lessonRoom, forecast, levelProgress, nextStage,
    similarKanji, sharedRadicals, leechScore, leeches, recentMistakes, search,
    confusions, soundFamily, STATES, stateOf, EXTRA_FILTERS, INSPECT_SORTS, inspect,
    activity, streak, forecastDays, levelTimes, median,
  };
});
