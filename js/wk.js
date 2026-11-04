// The WaniKani API v2 client, the sync and the outbox. No DOM; `fetch`, `sleep` and the
// storage are passed in, so the tests run it against fakes.
//
// The API answers browsers from any site (CORS `*`), so the page talks to it directly with
// your personal token. There is no server in between.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WK = api;
})(typeof self !== "undefined" ? self : this, function () {
  const API = "https://api.wanikani.com/v2";
  const REVISION = "20170710";
  // The browser cannot read the rate-limit headers from another site, so on a 429 we wait
  // these many seconds and try again.
  const BACKOFF = [15, 30, 60, 60];

  class WKError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status; // 0 = could not reach WaniKani
    }
  }

  function client(token, { fetch: f = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onWait } = {}) {
    async function request(pathOrUrl, { method = "GET", body } = {}) {
      const url = /^https:/.test(pathOrUrl) ? pathOrUrl : API + pathOrUrl;
      const headers = { Authorization: `Bearer ${token}`, "Wanikani-Revision": REVISION };
      if (body) headers["Content-Type"] = "application/json; charset=utf-8";
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await f(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
        } catch (e) {
          throw new WKError(0, "Can't reach WaniKani. Check your connection.");
        }
        if (res.status === 429 && attempt < BACKOFF.length) {
          if (onWait) onWait(BACKOFF[attempt]);
          await sleep(BACKOFF[attempt] * 1000);
          continue;
        }
        if (!res.ok) {
          let msg = "";
          try {
            msg = (await res.json()).error || "";
          } catch (e) {
            // No JSON body: the status says enough.
          }
          if (res.status === 401) msg = "WaniKani did not accept this token.";
          throw new WKError(res.status, msg || `WaniKani answered ${res.status}.`);
        }
        return res.json();
      }
    }

    // Every page of a collection. `onPage(data, { got, total })` runs per page.
    // Returns the newest data_updated_at, the cursor for the next `updated_after`.
    async function collection(path, params = {}, onPage) {
      const qs = new URLSearchParams(params).toString();
      let url = API + path + (qs ? `?${qs}` : "");
      let updated = null;
      let got = 0;
      while (url) {
        const page = await request(url);
        if (page.data_updated_at && (!updated || page.data_updated_at > updated)) updated = page.data_updated_at;
        got += page.data.length;
        if (onPage) await onPage(page.data, { got, total: page.total_count });
        url = page.pages && page.pages.next_url;
      }
      return { updated };
    }

    return {
      request,
      collection,
      user: () => request("/user"),
      review: (assignmentId, wrongMeaning, wrongReading, createdAt) => {
        const review = { assignment_id: assignmentId, incorrect_meaning_answers: wrongMeaning, incorrect_reading_answers: wrongReading };
        if (createdAt) review.created_at = createdAt;
        return request("/reviews", { method: "POST", body: { review } });
      },
      start: (assignmentId, startedAt) => request(`/assignments/${assignmentId}/start`, { method: "PUT", body: { assignment: { started_at: startedAt } } }),
    };
  }

  // The four collections we keep, in sync order.
  const COLLECTIONS = ["subjects", "assignments", "review_statistics", "study_materials"];

  // Downloads what changed since the last sync. The store needs:
  //   getMeta(key), setMeta(key, value), putMany(storeName, items)
  // onProgress({ name, got, total }) runs after each page.
  async function sync(api, store, onProgress) {
    const user = await api.user();
    await store.setMeta("user", user);
    const changed = {};
    for (const name of COLLECTIONS) {
      const since = await store.getMeta(`updated.${name}`);
      const params = since ? { updated_after: since } : {};
      changed[name] = 0;
      const { updated } = await api.collection(`/${name}`, params, async (data, p) => {
        changed[name] += data.length;
        await store.putMany(name, data);
        if (onProgress) onProgress({ name, got: p.got, total: p.total });
      });
      if (updated) await store.setMeta(`updated.${name}`, updated);
    }
    return { user, changed };
  }

  // A delay longer than this means the answer waited offline, so we tell WaniKani when it
  // really happened. Sent straight away, we leave the time out and the server uses its own
  // clock (a device clock running fast could otherwise give a time "in the future").
  const LATE_MS = 2 * 60e3;

  // Sends queued answers in order. outbox: { list(), remove(id) }.
  // Each entry: { id, kind: "review" | "start", assignmentId, wrongMeaning, wrongReading, at, unlockedAt? }.
  // onSent(entry, response) and onRejected(entry, error) let the caller update its cache.
  // Stops at the first entry that cannot go now (offline, server trouble, bad token) and leaves
  // it and the rest queued. Entries WaniKani refuses outright (422, 404) are dropped.
  async function flush(api, outbox, { now = () => Date.now(), onSent, onRejected } = {}) {
    const result = { sent: 0, rejected: 0, stopped: null };
    const entries = (await outbox.list()).sort((a, b) => a.id - b.id);
    for (const e of entries) {
      const late = now() - e.at > LATE_MS;
      try {
        let res;
        if (e.kind === "start") {
          // The start time is always sent, a minute early to stay clear of clock drift, but never
          // before the item unlocked.
          res = await api.start(e.assignmentId, new Date(Math.max(e.at - 60e3, (e.unlockedAt || 0) + 1000)).toISOString());
        } else {
          res = await api.review(e.assignmentId, e.wrongMeaning, e.wrongReading, late ? new Date(e.at).toISOString() : undefined);
        }
        await outbox.remove(e.id);
        result.sent++;
        if (onSent) await onSent(e, res);
      } catch (err) {
        const status = err && err.status;
        if (status === 422 || status === 404 || status === 400) {
          await outbox.remove(e.id);
          result.rejected++;
          if (onRejected) await onRejected(e, err);
          continue;
        }
        result.stopped = status === 401 || status === 403 ? "auth" : status === 0 ? "offline" : "server";
        result.error = err;
        break;
      }
    }
    return result;
  }

  return { API, REVISION, BACKOFF, WKError, client, COLLECTIONS, sync, LATE_MS, flush };
});
