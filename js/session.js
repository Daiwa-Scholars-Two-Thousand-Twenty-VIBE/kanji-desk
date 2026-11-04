// One quiz session: reviews, a lesson quiz, or practice. Pure logic, no DOM, so it runs in
// node tests too.
//
// Each item has one or two questions (meaning, and reading unless it is a radical or kana
// vocabulary). A wrong answer counts against that half and the question comes back later.
// An answer is only final when you move on (advance), so until then it can be retyped or
// marked right or wrong. When both halves are right the item is finished, and `advance`
// returns it with its miss counts so the caller can send the review.
//
// Items wait in `pool` and are worked on a few at a time from `active` (like the site's
// queue of 10). In strict mode the queue order is kept (sorted reviews); otherwise the next
// item is picked at random from `active`.
(function (root, factory) {
  const C = typeof module === "object" && module.exports ? require("./check.js") : root.Check;
  const api = factory(C);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Session = api;
})(typeof self !== "undefined" ? self : this, function (C) {
  // entries: [{ key, subject, synonyms, assignment? }]
  // opts: { activeSize, strict, questionOrder: "random" | "meaning" | "reading", backToBack, rng }
  function create(entries, opts = {}) {
    const o = Object.assign({ activeSize: 10, strict: false, questionOrder: "random", backToBack: false, rng: Math.random }, opts);
    const pool = entries.slice();
    const active = [];
    const done = [];
    const total = entries.length;
    let cur = null; // { item, kind }
    let answer = null; // { text, result, right, message, matched, changed }
    let last = null; // the item asked last, so it is not asked twice in a row
    let follow = null; // back-to-back: { item, kind } for the other half, asked next
    let wrapping = false;
    let asked = 0;
    let rightFirstGo = 0;

    const makeItem = (entry) => ({ entry, todo: new Set(C.questionsFor(entry.subject)), wrong: { meaning: 0, reading: 0 } });

    function refill() {
      while (!wrapping && active.length < o.activeSize && pool.length) active.push(makeItem(pool.shift()));
    }

    function kindFor(item) {
      const todo = [...item.todo];
      if (todo.length === 1) return todo[0];
      if (o.questionOrder === "meaning" || o.questionOrder === "reading") return o.questionOrder;
      return todo[Math.floor(o.rng() * todo.length)];
    }

    function pick() {
      refill();
      if (!active.length) {
        cur = null;
        return;
      }
      if (follow && active.includes(follow.item)) {
        cur = follow;
        follow = null;
        return;
      }
      follow = null;
      const choices = active.length > 1 ? active.filter((x) => x !== last) : active;
      const item = o.strict ? choices[0] : choices[Math.floor(o.rng() * choices.length)];
      cur = { item, kind: kindFor(item) };
    }

    function submit(text) {
      if (!cur || answer) return null;
      const r = C.check(cur.item.entry.subject, cur.kind, text, cur.item.entry.synonyms);
      if (C.counts(r.result)) answer = { text, result: r.result, right: C.isRight(r.result), message: r.message || "", matched: r.matched || "", changed: false };
      return r;
    }

    // Forget the answer and type again.
    const retype = () => {
      answer = null;
    };
    // Override the checker: count this answer as right (or wrong).
    function mark(right) {
      if (!answer) return;
      answer.changed = answer.right !== right ? !answer.changed : answer.changed;
      answer.right = right;
    }

    // Make the answer final and move on. Returns the finished item, if this answer finished one:
    // { entry, wrongMeaning, wrongReading }.
    function advance() {
      if (!cur || !answer) return null;
      const { item, kind, followed } = cur;
      asked++;
      if (answer.right) item.todo.delete(kind);
      else item.wrong[kind]++;
      answer = null;
      last = item;
      let finished = null;
      const i = active.indexOf(item);
      if (!item.todo.size) {
        active.splice(i, 1);
        finished = { entry: item.entry, wrongMeaning: item.wrong.meaning, wrongReading: item.wrong.reading };
        if (!finished.wrongMeaning && !finished.wrongReading) rightFirstGo++;
        done.push(finished);
      } else {
        // Back-to-back asks the other half straight away. Either way the item goes to the back
        // of the queue, so a missed question comes back after the others.
        // Only once per pair: the half asked as the follow-up does not pull its partner back.
        const other = [...item.todo].find((k) => k !== kind);
        if (o.backToBack && other && !followed) follow = { item, kind: other, followed: true };
        active.splice(i, 1);
        active.push(item);
      }
      pick();
      return finished;
    }

    // Wrap up: finish the items already in the queue, take no new ones. Call again with false to undo.
    function wrapUp(on = true) {
      wrapping = on;
      if (!on && cur) refill();
    }

    function stats() {
      const wrongAnswers = done.reduce((n, d) => n + d.wrongMeaning + d.wrongReading, 0) + active.reduce((n, x) => n + x.wrong.meaning + x.wrong.reading, 0);
      return {
        total,
        done: done.length,
        remaining: pool.length + active.length,
        active: active.length,
        queued: pool.length,
        asked,
        rightPct: asked ? Math.round((100 * (asked - wrongAnswers)) / asked) : 100,
        rightFirstGo,
        wrapping,
      };
    }

    pick();
    return {
      current: () => cur,
      answer: () => answer,
      submit, retype, mark, advance, wrapUp, stats,
      finished: () => done.slice(),
      // The questions of the current item still to answer, besides this one.
      otherTodo: () => (cur ? [...cur.item.todo].filter((k) => k !== cur.kind) : []),
    };
  }

  return { create };
});
