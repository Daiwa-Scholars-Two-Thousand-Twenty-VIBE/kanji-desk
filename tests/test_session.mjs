// node --test tests/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Session = require("../js/session.js");
const Items = require("../js/items.js");
const { SUBJECTS } = require("../js/demo.js");
const S = (id) => SUBJECTS.find((s) => s.id === id);
const entry = (id, synonyms = []) => ({ key: id, subject: S(id), synonyms });

// The right answer for whatever is being asked.
function rightAnswer(cur) {
  const d = cur.item.entry.subject.data;
  if (cur.kind === "meaning") return d.meanings[0].meaning;
  return d.readings.find((r) => r.accepted_answer).reading;
}
// Answers until the session ends. `wrongOnce` lists "id:kind" questions to miss the first time.
function runAll(s, wrongOnce = new Set()) {
  const finished = [];
  const missed = new Set();
  for (let guard = 0; s.current() && guard < 200; guard++) {
    const cur = s.current();
    const tag = `${cur.item.entry.key}:${cur.kind}`;
    if (wrongOnce.has(tag) && !missed.has(tag)) {
      missed.add(tag);
      s.submit(cur.kind === "meaning" ? "zzzzzz" : "ぬぬぬ");
    } else s.submit(rightAnswer(cur));
    const f = s.advance();
    if (f) finished.push(f);
  }
  return finished;
}

test("every item finishes once, with no misses when all answers are right", () => {
  const s = Session.create([entry(1), entry(10), entry(20), entry(30)], { rng: Items.mulberry32(1) });
  const finished = runAll(s);
  assert.equal(finished.length, 4);
  assert.deepEqual(finished.map((f) => f.entry.key).sort((a, b) => a - b), [1, 10, 20, 30]);
  assert.ok(finished.every((f) => f.wrongMeaning === 0 && f.wrongReading === 0));
  const st = s.stats();
  assert.equal(st.done, 4);
  assert.equal(st.remaining, 0);
  assert.equal(st.asked, 6); // 2 meaning-only items + 2 items with two halves
  assert.equal(st.rightPct, 100);
});

test("a missed question comes back and counts against its half", () => {
  const s = Session.create([entry(10), entry(20)], { rng: Items.mulberry32(2) });
  const finished = runAll(s, new Set(["10:reading", "20:meaning"]));
  const by = Object.fromEntries(finished.map((f) => [f.entry.key, f]));
  assert.deepEqual([by[10].wrongMeaning, by[10].wrongReading], [0, 1]);
  assert.deepEqual([by[20].wrongMeaning, by[20].wrongReading], [1, 0]);
  assert.equal(s.stats().asked, 6);
  assert.equal(s.stats().rightPct, 67);
});

test("retype forgets the answer, and mark overrides the checker", () => {
  const s = Session.create([entry(1)]);
  assert.equal(s.current().kind, "meaning");
  s.submit("wrong answer");
  assert.equal(s.answer().right, false);
  s.retype();
  assert.equal(s.answer(), null);
  s.submit("grond"); // "ground" is 6 letters, so 1 typo is forgiven
  assert.equal(s.answer().result, "close");
  s.mark(false);
  assert.equal(s.answer().right, false);
  assert.equal(s.answer().changed, true);
  s.mark(true);
  assert.equal(s.answer().changed, false);
  const f = s.advance();
  assert.equal(f.wrongMeaning, 0);
});

test("a shake (other reading, Japanese in the meaning box) does not count or lock the answer", () => {
  const s = Session.create([entry(10)], { questionOrder: "reading" });
  assert.equal(s.current().kind, "reading");
  const r = s.submit("くち");
  assert.equal(r.result, "other");
  assert.equal(s.answer(), null);
  assert.equal(s.advance(), null);
  s.submit("こう");
  assert.equal(s.answer().right, true);
});

test("question order: meaning first, and back-to-back asks the other half next", () => {
  const entries = [entry(10), entry(11), entry(12), entry(13)];
  const s = Session.create(entries, { questionOrder: "meaning", backToBack: true, rng: Items.mulberry32(3) });
  for (let i = 0; i < 4; i++) {
    const first = s.current();
    assert.equal(first.kind, "meaning");
    s.submit(rightAnswer(first));
    s.advance();
    const second = s.current();
    assert.equal(second.item, first.item);
    assert.equal(second.kind, "reading");
    s.submit(rightAnswer(second));
    assert.ok(s.advance());
  }
  assert.equal(s.current(), null);
});

test("back-to-back after a miss asks the other half, then the missed one later", () => {
  const s = Session.create([entry(10), entry(11)], { questionOrder: "meaning", backToBack: true, rng: Items.mulberry32(4) });
  const first = s.current();
  s.submit("zzzzzz");
  s.advance();
  assert.equal(s.current().item, first.item);
  assert.equal(s.current().kind, "reading");
  s.submit(rightAnswer(s.current()));
  s.advance();
  assert.notEqual(s.current().item, first.item); // the missed meaning waits behind the other item
});

test("strict order keeps the queue order", () => {
  const order = [entry(1), entry(2), entry(3), entry(4), entry(5)];
  const s = Session.create(order, { strict: true, activeSize: 10 });
  const seen = [];
  while (s.current()) {
    seen.push(s.current().item.entry.key);
    s.submit(rightAnswer(s.current()));
    s.advance();
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test("wrap-up finishes the active items and takes no new ones", () => {
  const ids = [1, 2, 3, 4, 5];
  const s = Session.create(ids.map((id) => entry(id)), { activeSize: 2, strict: true });
  s.wrapUp();
  const finished = runAll(s);
  assert.equal(finished.length, 2);
  assert.equal(s.stats().queued, 3);
  assert.equal(s.current(), null);
});

test("never the same item twice in a row while others are waiting", () => {
  const s = Session.create([entry(10), entry(11), entry(12)], { rng: Items.mulberry32(5) });
  let prev = null;
  while (s.current()) {
    const cur = s.current();
    if (prev && s.stats().active > 1) assert.notEqual(cur.item, prev);
    prev = cur.item;
    s.submit(rightAnswer(cur));
    s.advance();
  }
});

test("your synonyms are accepted", () => {
  const s = Session.create([entry(13, ["human"])], { questionOrder: "meaning" });
  s.submit("human");
  assert.equal(s.answer().right, true);
});
