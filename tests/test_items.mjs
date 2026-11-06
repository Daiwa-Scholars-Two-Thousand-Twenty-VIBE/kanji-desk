// node --test tests/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const I = require("../js/items.js");
const Demo = require("../js/demo.js");
const W = require("../vendor/wanakana.min.js");

// 4 Nov 2026, 10:20 local time.
const NOW = new Date(2026, 10, 4, 10, 20).getTime();
const model = () => I.buildModel(Demo.build(NOW));
const ids = (entries) => entries.map((e) => e.subject.id).sort((a, b) => a - b);

test("reviews due now and lessons waiting", () => {
  const m = model();
  assert.deepEqual(ids(I.reviewsDue(m, NOW)), [1, 2, 3, 4, 10, 11, 12, 13, 15, 20]);
  assert.deepEqual(ids(I.lessonsAvailable(m)), [14, 21, 30]);
  // Answered but not yet sent: left out so it is not asked twice.
  assert.deepEqual(ids(I.reviewsDue(m, NOW, new Set([1001, 1010]))), [2, 3, 4, 11, 12, 13, 15, 20]);
});

test("hidden assignments and levels past the subscription are left out", () => {
  const m = model();
  m.bySubject.get(10).data.hidden = true;
  m.user.data.subscription.max_level_granted = 1;
  assert.deepEqual(ids(I.reviewsDue(m, NOW)), [1, 2, 3, 4, 11]);
});

test("review orders", () => {
  const m = model();
  const due = I.reviewsDue(m, NOW);
  const rng = I.mulberry32(7);
  const lv = I.orderReviews(due, "level-asc", { rng }).map((e) => e.subject.data.level);
  assert.deepEqual(lv, lv.slice().sort((a, b) => a - b));
  const srs = I.orderReviews(due, "srs-asc", { rng }).map((e) => e.assignment.data.srs_stage);
  assert.deepEqual(srs, srs.slice().sort((a, b) => a - b));
  const types = I.orderReviews(due, "type", { rng }).map((e) => e.subject.object);
  assert.equal(types.lastIndexOf("radical") < types.indexOf("kanji"), true);
  assert.equal(types.lastIndexOf("kanji") < types.indexOf("vocabulary"), true);
  // Radical 3 is Master and 100 hours late (0.14 of its interval); kanji 12 is Apprentice II and
  // 20 hours late (2.5 intervals), so 12 comes first.
  const od = I.orderReviews(due, "overdue", { rng, now: NOW }).map((e) => e.subject.id);
  assert.ok(od.indexOf(12) < od.indexOf(3));
  const cur = I.orderReviews(due, "current-level", { rng, level: 2 }).map((e) => e.subject.data.level);
  assert.deepEqual(cur.slice(0, 5), [2, 2, 2, 2, 1]); // four level-2 items are due
  assert.equal(I.orderReviews(due, "random", { rng }).length, due.length);
});

test("filters: types and a limit", () => {
  const m = model();
  const due = I.reviewsDue(m, NOW);
  assert.deepEqual(ids(I.filterReviews(due, { types: { radical: false, kanji: true, vocabulary: true } })), [10, 11, 12, 13, 15, 20]);
  assert.equal(I.filterReviews(due, { limit: 3 }).length, 3);
});

test("lesson orders", () => {
  const m = model();
  const ls = I.lessonsAvailable(m);
  assert.deepEqual(I.orderLessons(ls, "wk").map((e) => e.subject.id), [14, 21, 30]);
  assert.deepEqual(I.orderLessons(ls, "kanji-first").map((e) => e.subject.id)[0], 14);
});

test("lesson caps: apprentice count and lessons today", () => {
  const m = model();
  const c = I.counts(m, NOW);
  assert.equal(c.apprentice, 9);
  assert.equal(I.lessonRoom(m, NOW, {}), Infinity);
  assert.equal(I.lessonRoom(m, NOW, { apprenticeCap: 12 }), 3);
  assert.equal(I.lessonRoom(m, NOW, { apprenticeCap: 5 }), 0);
  m.bySubject.get(14).data.started_at = new Date(NOW - 60e3).toISOString();
  assert.equal(I.counts(m, NOW).lessonsToday, 1);
  assert.equal(I.lessonRoom(m, NOW, { dailyCap: 3 }), 2);
});

test("forecast buckets by clock hour", () => {
  const m = model();
  const f = I.forecast(m, NOW, 24);
  assert.equal(f.length, 24);
  // Radical 5 comes in 3 hours (13:20), so it lands in the bucket ending 14:00.
  assert.equal(new Date(f[3].at).getHours(), 14);
  assert.equal(f[3].count, 1);
  // Vocabulary 22 comes in 7 hours. Vocabulary 23 (26 hours) is past the window.
  assert.equal(f.reduce((n, b) => n + b.count, 0), 2);
});

test("forecast buckets split by item type and SRS stage", () => {
  const m = model();
  m.bySubject.get(22).data.srs_stage = 7; // Master
  const f = I.forecast(m, NOW, 24);
  assert.deepEqual(f[3].type, { radical: 1, kanji: 0, vocabulary: 0 });
  assert.deepEqual(f[3].stage, { apprentice: 1, guru: 0, master: 0, enlightened: 0 });
  assert.deepEqual(f[7].type, { radical: 0, kanji: 0, vocabulary: 1 });
  assert.deepEqual(f[7].stage, { apprentice: 0, guru: 0, master: 1, enlightened: 0 });
  // The splits always add up to the count, in the week ahead too.
  for (const b of [...f, ...I.forecastDays(m, NOW, 7)]) {
    const sum = (o) => Object.values(o).reduce((a, n) => a + n, 0);
    assert.equal(sum(b.type), b.count);
    assert.equal(sum(b.stage), b.count);
  }
});

test("level progress counts kanji at Guru or above", () => {
  const m = model();
  m.user.data.level = 2;
  // Level 2 kanji: 12 (Apprentice), 13 (Apprentice), 14 (lesson), 15 (Apprentice).
  assert.deepEqual(I.levelProgress(m), { level: 2, total: 4, passed: 0, need: 4 });
  m.bySubject.get(13).data.passed_at = new Date(NOW).toISOString();
  assert.equal(I.levelProgress(m).passed, 1);
});

test("next SRS stage follows the WaniKani rule", () => {
  assert.equal(I.nextStage(1, 0), 2);
  assert.equal(I.nextStage(8, 0), 9);
  assert.equal(I.nextStage(4, 1), 3);
  assert.equal(I.nextStage(4, 3), 2);
  assert.equal(I.nextStage(6, 1), 4); // Guru and up drop twice as far
  assert.equal(I.nextStage(2, 5), 1);
});

test("similar kanji and kanji that share radicals", () => {
  const m = model();
  assert.deepEqual(I.similarKanji(m, m.subjects.get(11)).map((s) => s.id), [10, 12]);
  // 日 (sun radical) is shared with 日 and 晴; 一 (ground) is shared with 本.
  const shared = I.sharedRadicals(m, m.subjects.get(12));
  assert.deepEqual(shared.map((h) => h.subject.id).sort(), [11, 14, 17]);
  assert.deepEqual(shared.find((h) => h.subject.id === 11).shared.map((r) => r.id), [3]);
  // 本 shares a radical with 木 (tree) and with 目 (ground).
  assert.deepEqual(I.sharedRadicals(m, m.subjects.get(14)).map((h) => h.subject.id).sort(), [12, 15]);
});

test("leeches: misses over streak", () => {
  const m = model();
  const l = I.leeches(m);
  assert.deepEqual(l.map((x) => x.entry.subject.id), [12, 20]);
  assert.ok(l[0].score > l[1].score);
});

test("recent mistakes: this device's last day, newest first, no repeats, no practice", () => {
  const m = model();
  const H = 3600e3;
  const history = [
    { subjectId: 12, at: NOW - 2 * H, wrongMeaning: 1, wrongReading: 0, mode: "review" },
    { subjectId: 20, at: NOW - 1 * H, wrongMeaning: 0, wrongReading: 2, mode: "review" },
    { subjectId: 12, at: NOW - 3 * H, wrongMeaning: 1, wrongReading: 0, mode: "review" },
    { subjectId: 10, at: NOW - 30 * H, wrongMeaning: 1, wrongReading: 0, mode: "review" },
    { subjectId: 11, at: NOW - 1 * H, wrongMeaning: 0, wrongReading: 0, mode: "review" },
    { subjectId: 13, at: NOW - 1 * H, wrongMeaning: 3, wrongReading: 0, mode: "practice" },
  ];
  assert.deepEqual(I.recentMistakes(m, history, NOW).map((e) => e.subject.id), [20, 12]);
});

test("search by characters, meaning, synonym and reading", () => {
  const m = model();
  const kana = (q) => W.toHiragana(q);
  assert.equal(I.search(m, "人", kana)[0].id, 5); // radical first: same score, lower level
  assert.ok(I.search(m, "population", kana).some((s) => s.id === 20));
  assert.ok(I.search(m, "human", kana).some((s) => s.id === 13));
  assert.equal(I.search(m, "jinkou", kana)[0].id, 20);
  assert.equal(I.search(m, "", kana).length, 0);
});
