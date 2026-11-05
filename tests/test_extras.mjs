// The userscript features added after the first release: confusion hints, sound parts,
// pitch accent, the item inspector, the heatmap, level times and self-study halves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const I = require("../js/items.js");
const C = require("../js/check.js");
const P = require("../js/pitch.js");
const Session = require("../js/session.js");
const Demo = require("../js/demo.js");
const W = require("../vendor/wanakana.min.js");

const NOW = new Date(2026, 10, 4, 10, 20).getTime();
const DAY = 24 * 3600e3;
const model = () => I.buildModel(Demo.build(NOW));
const keisei = JSON.parse(readFileSync(new URL("../data/keisei.json", import.meta.url), "utf8"));

test("confusions: what your wrong answer fits, look-alikes first", () => {
  const m = model();
  const eye = m.subjects.get(12); // 目
  // "Sun" for 目: 日 (a look-alike) comes before the sun radical.
  assert.deepEqual(I.confusions(m, eye, "meaning", C.normalizeMeaning("sun"), C.normalizeMeaning).map((s) => s.id), [11, 3]);
  // The reading of 日 typed for 目.
  assert.deepEqual(I.confusions(m, eye, "reading", C.normalizeReading("nichi"), C.normalizeMeaning).map((s) => s.id), [11]);
  // Never the item itself, and nothing for an answer that fits nothing.
  assert.deepEqual(I.confusions(m, eye, "meaning", "eye", C.normalizeMeaning), []);
  assert.deepEqual(I.confusions(m, eye, "meaning", "spaceship", C.normalizeMeaning), []);
  // Items above your level that you have not learned are left out.
  m.user.data.level = 1;
  assert.deepEqual(I.confusions(m, m.subjects.get(10), "reading", "せい", C.normalizeMeaning), []);
});

test("sound parts from the Kanjium data", () => {
  const m = model();
  const clear = I.soundFamily(m, m.subjects.get(17), keisei, W.toHiragana); // 晴
  assert.equal(clear.part, "青");
  assert.ok(clear.compound);
  assert.ok(clear.readings.includes("せい"));
  assert.deepEqual(clear.shared, ["せい"]);
  assert.equal(clear.partSubject.id, 16);
  assert.deepEqual(clear.family.map((x) => x.subject.id), [16]);
  const blue = I.soundFamily(m, m.subjects.get(16), keisei, W.toHiragana); // 青, a sound part itself
  assert.ok(blue.isPart);
  assert.deepEqual(blue.family.map((x) => [x.subject.id, x.shared]), [[17, ["せい"]]]);
  // Vocabulary and kanji with no sound part get nothing.
  assert.equal(I.soundFamily(m, m.subjects.get(20), keisei), null);
  assert.equal(I.soundFamily(m, m.subjects.get(14), keisei), null); // 本
  assert.equal(I.soundFamily(m, m.subjects.get(17), null), null);
});

test("inspector: filters and sorts", () => {
  const m = model();
  const all = { radical: true, kanji: true, vocabulary: true };
  const states = Object.fromEntries(I.STATES.map((k) => [k, true]));
  const ids = (rows) => rows.map((r) => r.subject.id);
  const base = { from: 1, to: 60, types: all, states, extra: "none", sort: "level" };
  assert.equal(I.inspect(m, base, NOW).length, m.subjects.size);
  // Level 3 kanji: 青 and 晴, both locked.
  const l3 = I.inspect(m, { ...base, from: 3, to: 3, types: { radical: false, kanji: true, vocabulary: false } }, NOW);
  assert.deepEqual(ids(l3), [16, 17]);
  assert.deepEqual(l3.map((r) => r.state), ["locked", "locked"]);
  // Stage filter: lessons only.
  assert.deepEqual(ids(I.inspect(m, { ...base, states: { ...Object.fromEntries(I.STATES.map((k) => [k, false])), lesson: true } }, NOW)).sort((a, b) => a - b), [14, 21, 30]);
  // Leeches and "missed last time" come from the review statistics.
  assert.deepEqual(ids(I.inspect(m, { ...base, extra: "leeches", sort: "leech" }, NOW)), [12, 20]);
  assert.deepEqual(ids(I.inspect(m, { ...base, extra: "missed-last" }, NOW)), [12, 20]);
  // Worst accuracy first, items with no stats last.
  const acc = I.inspect(m, { ...base, sort: "accuracy" }, NOW);
  assert.deepEqual(ids(acc).slice(0, 3), [12, 20, 11]);
  assert.equal(acc[acc.length - 1].accuracy, null);
  // Due in the next 24 hours includes what is due now.
  const soon = I.inspect(m, { ...base, extra: "due-today", sort: "next" }, NOW);
  assert.ok(ids(soon).includes(5) && ids(soon).includes(22) && !ids(soon).includes(23));
  // Missed in the last 24 hours, from this device's log.
  const log = [{ subjectId: 13, at: NOW - 3600e3, wrongMeaning: 1, wrongReading: 0, mode: "reviews" }];
  assert.deepEqual(ids(I.inspect(m, { ...base, extra: "recent-mistakes" }, NOW, log)), [13]);
});

test("heatmap counts, streaks and the week ahead", () => {
  const m = model();
  const log = [
    { subjectId: 10, at: NOW - 3600e3, wrongMeaning: 0, wrongReading: 1, mode: "reviews" },
    { subjectId: 11, at: NOW - 3600e3, wrongMeaning: 0, wrongReading: 0, mode: "reviews" },
    { subjectId: 12, at: NOW - DAY, wrongMeaning: 0, wrongReading: 0, mode: "reviews" },
    { subjectId: 12, at: NOW - DAY, wrongMeaning: 0, wrongReading: 0, mode: "practice" },
    { subjectId: 13, at: NOW - 3 * DAY, wrongMeaning: 0, wrongReading: 0, mode: "reviews" },
  ];
  const byDay = I.activity(m, log, NOW);
  const today = I.startOfDay(NOW);
  assert.deepEqual(byDay.get(today), { lessons: 0, reviews: 2, missed: 1 });
  assert.equal(byDay.get(I.startOfDay(NOW - DAY)).reviews, 1); // practice is not a review
  assert.equal(I.streak(byDay, NOW, "reviews"), 2);
  // All demo lessons were started 9 days ago.
  assert.equal(byDay.get(I.startOfDay(NOW - 9 * DAY)).lessons, 13);
  const week = I.forecastDays(m, NOW, 7);
  assert.equal(week.length, 7);
  assert.equal(week[0].at, today);
  assert.equal(week.reduce((t, b) => t + b.count, 0), 3); // in 3, 7 and 26 hours
});

test("level times from level progressions", () => {
  const m = model();
  const lt = I.levelTimes(m, NOW);
  assert.deepEqual(lt.map((x) => [x.level, Math.round(x.ms / DAY), x.current]), [[1, 9, false], [2, 9, false], [3, 12, true]]);
  assert.equal(I.median([3, 1, 2]), 2);
  assert.equal(I.median([4, 1, 2, 3]), 2.5);
  // A reset leaves an abandoned progression; the live one wins.
  I.apply(m, "level_progressions", [{ id: 1, data: { level: 3, created_at: "2020-01-01T00:00:00Z", unlocked_at: "2020-01-01T00:00:00Z", abandoned_at: "2020-02-01T00:00:00Z" } }]);
  assert.equal(I.levelTimes(m, NOW).length, 3);
});

test("pitch: parse, morae and patterns", () => {
  const map = P.parse("日本\tにほん\t2\n日本\tにっぽん\t3\nゆっくり\t\t3\n木目\tもくめ\t0,3\n一寸\tちょっと\t(副)1,(名)0\nbad line\n");
  assert.deepEqual(P.lookup(map, "日本", "にほん"), [2]);
  assert.deepEqual(P.lookup(map, "ゆっくり", ""), [3]);
  assert.deepEqual(P.lookup(map, "木目", "もくめ"), [0, 3]);
  assert.deepEqual(P.lookup(map, "一寸", "ちょっと"), [1, 0]);
  assert.deepEqual(P.lookup(map, "猫", "ねこ"), []);
  assert.deepEqual(P.morae("きょう"), ["きょ", "う"]);
  assert.deepEqual(P.morae("ちょっと"), ["ちょ", "っ", "と"]);
  assert.deepEqual(P.pattern(3, 0), { high: [false, true, true], particle: true }); // heiban
  assert.deepEqual(P.pattern(3, 1), { high: [true, false, false], particle: false }); // atamadaka
  assert.deepEqual(P.pattern(3, 2), { high: [false, true, false], particle: false }); // nakadaka
  assert.deepEqual(P.pattern(3, 3), { high: [false, true, true], particle: false }); // odaka
  assert.equal(P.kind(3, 0), "heiban");
  assert.equal(P.kind(3, 2), "nakadaka");
  assert.equal(P.kind(3, 3), "odaka");
  // The real list has the demo words.
  const real = P.parse(readFileSync(new URL("../data/pitch.tsv", import.meta.url), "utf8"));
  assert.deepEqual(P.lookup(real, "人口", "じんこう"), [0]);
  assert.deepEqual(P.lookup(real, "日本", "にほん"), [2]);
});

test("self-study can ask one half only", () => {
  const S = (id) => Demo.SUBJECTS.find((s) => s.id === id);
  const entries = [10, 1, 30].map((id) => ({ key: id, subject: S(id), synonyms: [] }));
  const s = Session.create(entries, { kinds: ["reading"], rng: () => 0, activeSize: 10 });
  const asked = [];
  while (s.current()) {
    const c = s.current();
    asked.push([c.item.entry.subject.id, c.kind]);
    const answer = c.kind === "reading" ? "こう" : C.acceptedMeanings(c.item.entry.subject, [])[0];
    s.submit(answer);
    if (!s.answer().right) s.mark(true);
    s.advance();
  }
  // 口 asks its reading only; the radical and the kana word have no reading, so they keep their meaning.
  assert.deepEqual(asked.map((x) => x.join(":")).sort(), ["10:reading", "1:meaning", "30:meaning"]);
});
