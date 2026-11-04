// Queues, ordering, related items and dashboard numbers. Pure functions, no DOM, so they run
// in node tests too.
//
// Everything reads from one `model`, built by the app from the cached API data:
//   { user, subjects: Map(id -> subject), assignments: Map(id -> assignment),
//     bySubject: Map(subjectId -> assignment), stats: Map(subjectId -> review_statistic),
//     materials: Map(subjectId -> study_material) }
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
    }
  }

  function buildModel({ user, subjects = [], assignments = [], review_statistics = [], study_materials = [] }) {
    const m = { user, subjects: new Map(), assignments: new Map(), bySubject: new Map(), stats: new Map(), materials: new Map() };
    apply(m, "subjects", subjects);
    apply(m, "assignments", assignments);
    apply(m, "review_statistics", review_statistics);
    apply(m, "study_materials", study_materials);
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
  function leeches(m, limit = 30) {
    const out = [];
    for (const st of m.stats.values()) {
      const d = st.data;
      if (d.hidden) continue;
      const a = m.bySubject.get(d.subject_id);
      if (!a || a.data.hidden || !a.data.started_at || a.data.srs_stage >= 9) continue;
      const s = m.subjects.get(d.subject_id);
      if (!usable(m, s)) continue;
      const half = (wrong, streak) => wrong / Math.pow(Math.max(1, streak), 1.5);
      const score = Math.max(half(d.meaning_incorrect, d.meaning_current_streak),
        s.object === "radical" || s.object === "kana_vocabulary" ? 0 : half(d.reading_incorrect, d.reading_current_streak));
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

  return {
    STAGE_NAMES, stageGroup, INTERVAL_HOURS, REVIEW_ORDERS, LESSON_ORDERS, HOUR,
    mulberry32, shuffle, apply, buildModel, usable, synonymsFor, entryOf,
    reviewsDue, lessonsAvailable, overdue, orderReviews, filterReviews, orderLessons,
    startOfDay, counts, lessonRoom, forecast, levelProgress, nextStage,
    similarKanji, sharedRadicals, leeches, recentMistakes, search,
  };
});
