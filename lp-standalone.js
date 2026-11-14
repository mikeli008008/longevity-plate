/* Longevity Plate — standalone runtime.
   Provides the same window.claude.use("db" | "user" | "sample") interface the app uses inside claude.ai,
   backed by Supabase (auth + Postgres "docs" table + "ai" Edge Function). */
(function () {
  const cfg = window.LP_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.error('Longevity Plate: missing Supabase config (config.js).');
    return;
  }
  const fromLink = /access_token|refresh_token|code=/.test(location.hash + location.search);
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  window.LP_STANDALONE = true;
  window.LP_SB = sb;

  let uid = null;
  const ready = sb.auth.getSession().then(({ data }) => {
    uid = data.session?.user?.id || null;
    // arriving from the email link: drop the tokens from the address bar and open the app
    if (uid && fromLink) history.replaceState(null, '', location.pathname + '#app');
    return uid;
  });
  sb.auth.onAuthStateChange((ev, session) => {
    const next = session?.user?.id || null;
    if ((ev === 'SIGNED_IN' && next && next !== uid) || ev === 'SIGNED_OUT') { location.hash = 'app'; location.reload(); }
  });

  /* ---------------- db ---------------- */
  const parentOf = (p) => p.split('/').slice(0, -1).join('/');
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const mapErr = (e) => {
    const msg = e?.message || String(e);
    if (e?.code === '42501' || /row-level security/i.test(msg)) return { code: 'invalid_argument', message: msg };
    return { code: 'unavailable', message: msg };
  };
  const docSnap = (path, data) => ({ id: path.split('/').pop(), exists: data != null, data: () => (data == null ? undefined : clone(data)), metadata: { fromCache: false, hasPendingWrites: false } });
  const listeners = new Set();

  async function fetchDoc(path) {
    const { data, error } = await sb.from('docs').select('data').eq('path', path).maybeSingle();
    if (error) throw mapErr(error);
    return data ? data.data : null;
  }
  async function runQuery(q) {
    let r = sb.from('docs').select('path,data').eq('parent', q.path);
    for (const [f, op, v] of q.where) {
      if (op !== '==') throw { code: 'invalid_argument', message: 'only == filters are supported' };
      r = r.eq('data->>' + f, String(v));
    }
    if (q.order) r = r.order('data->>' + q.order[0], { ascending: q.order[1] !== 'desc' });
    else r = r.order('path', { ascending: true });
    if (q.limit) r = r.limit(q.limit);
    const { data, error } = await r;
    if (error) throw mapErr(error);
    const docs = (data || []).map((row) => docSnap(row.path, row.data));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  async function deliver(l) {
    try { l.cb(l.kind === 'doc' ? docSnap(l.path, await fetchDoc(l.path)) : await runQuery(l.q)); }
    catch (e) { if (l.err) l.err(e); }
  }
  function notify(path) {
    listeners.forEach((l) => {
      if ((l.kind === 'doc' && l.path === path) || (l.kind === 'col' && l.q.path === parentOf(path))) deliver(l);
    });
  }
  // Refresh when the page comes back to the foreground (another device may have written).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') listeners.forEach(deliver); });

  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      async get() { return docSnap(path, await fetchDoc(path)); },
      async set(data) {
        const { error } = await sb.from('docs').upsert({ path, parent: parentOf(path), data, updated_at: new Date().toISOString() });
        if (error) throw mapErr(error);
        notify(path);
      },
      async update(patch) {
        const cur = await fetchDoc(path);
        if (cur == null) throw { code: 'invalid_argument', message: 'document does not exist' };
        const merge = (a, b) => { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], b[k]); else a[k] = b[k]; } return a; };
        await this.set(merge(cur, patch));
      },
      async delete() {
        const { error } = await sb.from('docs').delete().eq('path', path);
        if (error) throw mapErr(error);
        notify(path);
      },
      onSnapshot(cb, err) { const l = { kind: 'doc', path, cb, err }; listeners.add(l); deliver(l); return () => listeners.delete(l); },
      collection(c) { return colRef(path + '/' + c); },
      async acquire() { return { acquired: true }; },
    };
  }
  function query(q) {
    return {
      where: (f, op, v) => query({ ...q, where: [...q.where, [f, op, v]] }),
      orderBy: (f, dir) => query({ ...q, order: [f, dir || 'asc'] }),
      limit: (n) => query({ ...q, limit: n }),
      get: () => runQuery(q),
      onSnapshot(cb, err) { const l = { kind: 'col', q, cb, err }; listeners.add(l); deliver(l); return () => listeners.delete(l); },
    };
  }
  function colRef(path) {
    const q = query({ path, where: [], order: null, limit: 0 });
    return Object.assign(q, {
      path,
      doc: (id) => docRef(path + '/' + (id || crypto.randomUUID())),
      async add(data) { const r = docRef(path + '/' + crypto.randomUUID()); await r.set(data); return r; },
    });
  }
  const db = { doc: docRef, collection: colRef };

  /* ---------------- user ---------------- */
  let adminP = null;
  const user = {
    id: async () => { await ready; return uid; },
    me: async () => { await ready; return { id: uid }; },
    isOwner: () => {
      if (!adminP) adminP = ready.then(async () => {
        if (!uid) return false;
        const { data } = await sb.from('admins').select('user_id').eq('user_id', uid).maybeSingle();
        return !!data;
      });
      return adminP;
    },
    canEdit() { return this.isOwner(); },
    can: async () => true,
    profiles: async () => ({}),
  };

  /* ---------------- sample (AI) ---------------- */
  const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function sample(input, opts = {}) {
    const prompt = typeof input === 'string' ? input : (input || []).map((m) => m.content).join('\n\n');
    const images = opts.images ? await Promise.all(opts.images.map(toB64)) : [];
    const { data, error } = await sb.functions.invoke('ai', { body: { prompt, images, modelTier: opts.modelTier || 'default' } });
    if (error) {
      let detail = '';
      try { detail = (await error.context?.json())?.error || ''; } catch (e) {}
      if (detail === 'rate_limited') throw { code: 'rate_limited', message: 'Daily AI limit reached. Try again tomorrow.' };
      throw { code: 'unavailable', message: detail || error.message };
    }
    const text = data?.text || '';
    if (opts.onText) try { opts.onText({ text, delta: text }); } catch (e) {}
    return { text, truncated: !!data?.truncated };
  }
  sample.limits = async () => ({ images: true, maxImages: 4 });
  sample.json = async (input, opts) => { const r = await sample(input, opts); const t = r.text.replace(/```json|```/g, ''); return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); };

  /* ---------------- claude.use ---------------- */
  window.claude = {
    async use(name) {
      await ready;
      if (name === 'db') return uid ? db : null;
      if (name === 'user') return uid ? user : null;
      if (name === 'sample') return uid ? sample : null;
      return null;
    },
  };
})();
