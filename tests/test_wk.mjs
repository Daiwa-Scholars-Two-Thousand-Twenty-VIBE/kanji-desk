// node --test tests/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WK = require("../js/wk.js");
const TOKEN = "fake-test-token-never-shown-123";
const API = "https://api.wanikani.com/v2";

const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fakeFetch(handle) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return handle(url, init, calls.length);
  };
  f.calls = calls;
  return f;
}
const noSleep = async () => {};

test("requests carry the token and the API revision", async () => {
  const f = fakeFetch(() => reply({ object: "user", data: { level: 27 } }));
  const api = WK.client(TOKEN, { fetch: f, sleep: noSleep });
  const u = await api.user();
  assert.equal(u.data.level, 27);
  assert.equal(f.calls[0].url, `${API}/user`);
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].headers["Wanikani-Revision"], "20170710");
});

test("collections follow next_url and report the newest data_updated_at", async () => {
  const pages = {
    [`${API}/subjects?updated_after=2026-01-01T00%3A00%3A00Z`]: { data: [{ id: 1 }, { id: 2 }], total_count: 3, data_updated_at: "2026-11-01T00:00:00Z", pages: { next_url: `${API}/subjects?page_after_id=2` } },
    [`${API}/subjects?page_after_id=2`]: { data: [{ id: 3 }], total_count: 3, data_updated_at: "2026-11-01T00:00:00Z", pages: { next_url: null } },
  };
  const f = fakeFetch((url) => reply(pages[url]));
  const api = WK.client(TOKEN, { fetch: f, sleep: noSleep });
  const got = [];
  const r = await api.collection("/subjects", { updated_after: "2026-01-01T00:00:00Z" }, (data, p) => got.push([data.length, p.got, p.total]));
  assert.deepEqual(got, [[2, 2, 3], [1, 3, 3]]);
  assert.equal(r.updated, "2026-11-01T00:00:00Z");
});

test("a 429 waits and tries again", async () => {
  const f = fakeFetch((url, init, n) => (n === 1 ? reply({ error: "Rate Limit Exceeded" }, 429) : reply({ ok: 1 })));
  const waits = [];
  const api = WK.client(TOKEN, { fetch: f, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await api.request("/user"), { ok: 1 });
  assert.deepEqual(waits, [15000]);
});

test("errors carry the status; no connection is status 0", async () => {
  const bad = WK.client(TOKEN, { fetch: fakeFetch(() => reply({ error: "Unauthorized" }, 401)), sleep: noSleep });
  await assert.rejects(bad.user(), (e) => e.status === 401 && /token/.test(e.message));
  const off = WK.client(TOKEN, { fetch: async () => { throw new TypeError("Failed to fetch"); }, sleep: noSleep });
  await assert.rejects(off.user(), (e) => e.status === 0);
});

test("review and start send the documented bodies", async () => {
  const f = fakeFetch(() => reply({}));
  const api = WK.client(TOKEN, { fetch: f, sleep: noSleep });
  await api.review(42, 1, 2);
  await api.review(43, 0, 0, "2026-11-04T01:00:00.000Z");
  await api.start(44, "2026-11-04T01:00:00.000Z");
  assert.equal(f.calls[0].url, `${API}/reviews`);
  assert.equal(f.calls[0].method, "POST");
  assert.deepEqual(f.calls[0].body, { review: { assignment_id: 42, incorrect_meaning_answers: 1, incorrect_reading_answers: 2 } });
  assert.deepEqual(f.calls[1].body.review.created_at, "2026-11-04T01:00:00.000Z");
  assert.equal(f.calls[2].url, `${API}/assignments/44/start`);
  assert.equal(f.calls[2].method, "PUT");
  assert.deepEqual(f.calls[2].body, { assignment: { started_at: "2026-11-04T01:00:00.000Z" } });
});

test("sync downloads only what changed since last time", async () => {
  const meta = new Map([["updated.assignments", "2026-11-03T00:00:00Z"]]);
  const stored = {};
  const store = {
    getMeta: async (k) => meta.get(k),
    setMeta: async (k, v) => meta.set(k, v),
    putMany: async (name, items) => (stored[name] = (stored[name] || []).concat(items)),
  };
  const f = fakeFetch((url) => {
    if (url.endsWith("/user")) return reply({ object: "user", data: { level: 27 } });
    const name = url.slice(API.length + 1).split("?")[0];
    return reply({ data: [{ id: name.length }], total_count: 1, data_updated_at: "2026-11-04T00:00:00Z", pages: { next_url: null } });
  });
  const r = await WK.sync(WK.client(TOKEN, { fetch: f, sleep: noSleep }), store);
  assert.deepEqual(f.calls.map((c) => c.url), [
    `${API}/user`,
    `${API}/subjects`,
    `${API}/assignments?updated_after=2026-11-03T00%3A00%3A00Z`,
    `${API}/review_statistics`,
    `${API}/study_materials`,
  ]);
  assert.equal(meta.get("updated.subjects"), "2026-11-04T00:00:00Z");
  assert.equal(r.changed.assignments, 1);
  assert.equal(stored.subjects.length, 1);
});

function memOutbox(entries) {
  const list = entries.slice();
  return {
    list: async () => list.slice(),
    remove: async (id) => list.splice(list.findIndex((e) => e.id === id), 1),
    left: () => list.map((e) => e.id),
  };
}

test("flush sends in order, adds the time only for late answers, drops refusals", async () => {
  const NOW = Date.parse("2026-11-04T10:00:00Z");
  const f = fakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.review && body.review.assignment_id === 3) return reply({ error: "Assignment not available" }, 422);
    return reply({ resources_updated: { assignment: { id: 1 } } });
  });
  const api = WK.client(TOKEN, { fetch: f, sleep: noSleep });
  const box = memOutbox([
    { id: 2, kind: "review", assignmentId: 2, wrongMeaning: 0, wrongReading: 1, at: NOW - 10 * 60e3 },
    { id: 1, kind: "review", assignmentId: 1, wrongMeaning: 1, wrongReading: 0, at: NOW - 5e3 },
    { id: 3, kind: "review", assignmentId: 3, wrongMeaning: 0, wrongReading: 0, at: NOW - 5e3 },
    { id: 4, kind: "start", assignmentId: 4, at: NOW - 5e3, unlockedAt: NOW - 30e3 },
  ]);
  const sent = [], rejected = [];
  const r = await WK.flush(api, box, { now: () => NOW, onSent: (e) => sent.push(e.id), onRejected: (e) => rejected.push(e.id) });
  assert.deepEqual(r, { sent: 3, rejected: 1, stopped: null });
  assert.deepEqual(sent, [1, 2, 4]);
  assert.deepEqual(rejected, [3]);
  assert.equal(f.calls[0].body.review.created_at, undefined); // sent at once: server clock
  assert.equal(f.calls[1].body.review.created_at, new Date(NOW - 10 * 60e3).toISOString()); // waited offline
  // Start time: a minute early, but never before the unlock.
  assert.equal(f.calls[3].body.assignment.started_at, new Date(NOW - 30e3 + 1000).toISOString());
  assert.deepEqual(box.left(), []);
});

test("flush stops and keeps the queue when offline or the token is refused", async () => {
  const box = memOutbox([{ id: 1, kind: "review", assignmentId: 1, wrongMeaning: 0, wrongReading: 0, at: 0 }, { id: 2, kind: "review", assignmentId: 2, wrongMeaning: 0, wrongReading: 0, at: 0 }]);
  const off = WK.client(TOKEN, { fetch: async () => { throw new TypeError("offline"); }, sleep: noSleep });
  const r = await WK.flush(off, box);
  assert.equal(r.stopped, "offline");
  assert.deepEqual(box.left(), [1, 2]);
  const auth = WK.client(TOKEN, { fetch: fakeFetch(() => reply({ error: "Unauthorized" }, 401)), sleep: noSleep });
  assert.equal((await WK.flush(auth, box)).stopped, "auth");
  assert.deepEqual(box.left(), [1, 2]);
});
