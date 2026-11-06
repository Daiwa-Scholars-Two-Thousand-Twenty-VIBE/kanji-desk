// node --test tests/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../js/check.js");
const { SUBJECTS } = require("../js/demo.js");
const S = (id) => SUBJECTS.find((s) => s.id === id);

test("which questions each type gets", () => {
  assert.deepEqual(C.questionsFor(S(1)), ["meaning"]); // radical
  assert.deepEqual(C.questionsFor(S(30)), ["meaning"]); // kana vocabulary
  assert.deepEqual(C.questionsFor(S(10)), ["meaning", "reading"]);
  assert.deepEqual(C.questionsFor(S(20)), ["meaning", "reading"]);
});

test("typo tolerance grows with length", () => {
  assert.equal(C.tolerance(3), 0);
  assert.equal(C.tolerance(4), 1);
  assert.equal(C.tolerance(7), 2);
  assert.equal(C.tolerance(14), 4);
});

test("meanings: exact, case, spaces and punctuation", () => {
  assert.equal(C.checkMeaning(S(11), "day").result, "exact");
  assert.equal(C.checkMeaning(S(11), "  SUN ").result, "exact");
  assert.equal(C.checkMeaning(S(22), "one-person").result, "exact");
  assert.equal(C.checkMeaning(S(22), "one  person").result, "exact");
  assert.equal(C.checkMeaning(S(23), "wood grain").result, "exact");
});

test("meanings: small typos are close, big ones are wrong", () => {
  const r = C.checkMeaning(S(20), "populaton");
  assert.equal(r.result, "close");
  assert.equal(r.matched, "Population");
  // Long words forgive more: "pollution" is 3 edits from "population", which allows 3.
  assert.equal(C.checkMeaning(S(20), "pollution").result, "close");
  assert.equal(C.checkMeaning(S(20), "politics").result, "wrong");
  // Three letters or fewer forgive nothing.
  assert.equal(C.checkMeaning(S(12), "eey").result, "wrong");
});

test("meanings: whitelist, blacklist and your synonyms", () => {
  assert.equal(C.checkMeaning(S(13), "people").result, "exact");
  assert.equal(C.checkMeaning(S(13), "man").result, "wrong");
  assert.equal(C.checkMeaning(S(13), "human").result, "wrong");
  assert.equal(C.checkMeaning(S(13), "human", ["human"]).result, "exact");
});

test("meanings: Japanese or empty input shakes instead of counting", () => {
  assert.equal(C.checkMeaning(S(13), "ひと").result, "invalid");
  assert.equal(C.checkMeaning(S(13), "人").result, "invalid");
  assert.match(C.checkMeaning(S(13), "人").message, /^Not quite: that is Japanese/);
  assert.equal(C.checkMeaning(S(13), "   ").result, "invalid");
});

test("meanings: the reading in the meaning box shakes, in kana or romaji", () => {
  for (const a of ["ひと", "jin", "Hito", "nin"]) {
    const r = C.checkMeaning(S(13), a);
    assert.equal(r.result, "invalid", a);
    assert.match(r.message, /that is the reading/, a);
  }
  assert.equal(C.checkMeaning(S(21), "nihon").result, "invalid"); // vocabulary too
  // Someone else's reading is just a wrong meaning.
  assert.equal(C.checkMeaning(S(20), "nihon").result, "wrong");
  // A meaning that is also a reading in romaji still counts as the meaning.
  const sake = { object: "vocabulary", data: { meanings: [{ meaning: "Sake", primary: true, accepted_answer: true }], readings: [{ reading: "さけ", primary: true, accepted_answer: true }] } };
  assert.equal(C.checkMeaning(sake, "sake").result, "exact");
  assert.equal(C.checkReading(sake, "sake").result, "exact");
});

test("readings: kana, romaji and katakana all work", () => {
  assert.equal(C.checkReading(S(20), "じんこう").result, "exact");
  assert.equal(C.checkReading(S(20), "jinkou").result, "exact");
  assert.equal(C.checkReading(S(20), "ジンコウ").result, "exact");
  assert.equal(C.checkReading(S(14), "hon").result, "exact"); // trailing n becomes ん
  assert.equal(C.checkReading(S(21), "にっぽん").result, "exact"); // second accepted reading
  assert.equal(C.checkReading(S(20), "じんこ").result, "wrong");
});

test("readings: no typo tolerance", () => {
  assert.equal(C.checkReading(S(10), "こお").result, "wrong");
});

test("readings: a kanji's other reading shakes and names the wanted one", () => {
  const r = C.checkReading(S(10), "くち");
  assert.equal(r.result, "other");
  assert.match(r.message, /on'yomi/);
  const k = C.checkReading(S(15), "もく");
  assert.equal(k.result, "other");
  assert.match(k.message, /kun'yomi/);
  // Every accepted on'yomi counts, not just the primary one.
  assert.equal(C.checkReading(S(10), "く").result, "exact");
  assert.equal(C.checkReading(S(11), "じつ").result, "exact");
});

test("readings: letters that cannot become kana shake", () => {
  // Romaji that fully converts is just a wrong reading, as the kana box would show it.
  assert.equal(C.checkReading(S(20), "same").result, "wrong");
  assert.equal(C.checkReading(S(20), "jinkou1").result, "invalid");
  assert.equal(C.checkReading(S(20), "人口").result, "invalid");
  const r = C.checkReading(S(20), "hand");
  assert.equal(r.result, "invalid");
  assert.match(r.message, /looks like English/);
});

test("readings: the meaning in the reading box shakes, even once it is kana", () => {
  // The kana box turns English into kana as you type: population -> ぽぷらちおん, eye -> えいぇ.
  for (const [id, a] of [[20, "population"], [20, "ぽぷらちおん"], [20, "Population"], [12, "eye"], [12, "えいぇ"], [15, "tree"], [13, "person"], [22, "one person"]]) {
    const r = C.checkReading(S(id), a);
    assert.equal(r.result, "invalid", `${id} ${a}`);
    assert.match(r.message, /that is the meaning/, `${id} ${a}`);
  }
  assert.equal(C.checkReading(S(20), "populaton").result, "invalid"); // a typo of a long meaning too
  assert.equal(C.checkReading(S(13), "people").result, "invalid"); // whitelisted meanings
  assert.equal(C.checkReading(S(13), "human").result, "wrong"); // ふまん: not one of its meanings, so a wrong reading
  assert.equal(C.check(S(13), "reading", "human", ["human"]).result, "invalid"); // your synonyms count as meanings
  assert.match(C.check(S(13), "reading", "human", ["human"]).message, /that is the meaning/);
  assert.equal(C.checkReading(S(12), "えい").result, "wrong"); // short meanings need an exact match
});

test("what counts", () => {
  assert.equal(C.isRight("close"), true);
  assert.equal(C.counts("other"), false);
  assert.equal(C.counts("invalid"), false);
  assert.equal(C.counts("wrong"), true);
});
