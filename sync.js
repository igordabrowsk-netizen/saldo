/* Saldo — baza danych w chmurze (Firebase: Auth + Firestore) i automatyczne kopie zapasowe.

   Model danych w chmurze:
   - users/{uid}/data/meta   — { v:2, cash, bank, cashAt, bankAt, loansAt, lastFund, loans:{id:{…}}, cats:{id:{…}} }
   - users/{uid}/entries/{id} — każdy wpis historii osobno
   - users/{uid}/inbox/{id}   — płatności Apple Pay dopisane przez Skróty
   - users/{uid}/backups/{id} — kopie automatyczne (części po ≤250 tys. znaków)

   Synchronizacja odporna na pracę na kilku urządzeniach i offline:
   - stany (gotówka, konto, kwoty pożyczek) wysyłane są jako PRZYROSTY (increment),
     a udziały pożyczek (z gotówki/konta) każde urządzenie wylicza z historii wpisów;
     więc zmiany z dwóch urządzeń się sumują, a nie nadpisują;
   - pożyczki i grupy są osobnymi pozycjami mapy (dodanie na jednym urządzeniu nie kasuje drugiego);
   - zmiany z chmury są łączone z niewysłanymi zmianami lokalnymi (lokalne nie giną);
   - nieudane wysłanie jest ponawiane (po powrocie internetu i co 20 s).
   Kopie automatyczne raz dziennie: w telefonie (IndexedDB, 14 dni) i w chmurze (30 dni). */
(function () {
  'use strict';
  var S = window.Saldo;
  if (!S) return;
  var icon = S.icon, esc = S.esc;
  var $ = function (id) { return document.getElementById(id); };

  var cfg = window.SALDO_FIREBASE_CONFIG;
  var configured = !!(cfg && cfg.apiKey && cfg.projectId);
  // Biblioteki Firebase wczytujemy dopiero po starcie aplikacji — wolny internet nie wstrzymuje ekranu
  var LIBS = ['app', 'auth', 'firestore'].map(function (m) { return 'https://www.gstatic.com/firebasejs/10.14.1/firebase-' + m + '-compat.js'; });
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = res; s.onerror = function () { s.remove(); rej(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }
  var LOCAL_KEEP = 14, CLOUD_KEEP = 30, CHUNK = 250000;
  // Identyfikator tego urządzenia (do potwierdzeń przejęcia płatności Apple Pay)
  var deviceId = (function () {
    try {
      var d = localStorage.getItem('saldo_device');
      if (!d) { d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('saldo_device', d); }
      return d;
    } catch (e) { return 'd' + Date.now().toString(36); }
  })();

  // ---------- Narzędzia ----------
  // JSON z posortowanymi kluczami — porównania nie zależą od kolejności pól zwracanej przez bazę
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function clean(o) { return JSON.parse(JSON.stringify(o)); } // usuwa undefined (Firestore ich nie przyjmuje)
  function n(v) { v = Number(v); return isFinite(v) ? Math.round(v) : 0; }
  function today() { return S.ymd(new Date()); }
  function summaryOf(s) { return { total: S.total(s), entries: (s.history || []).length }; }
  function FV() { return firebase.firestore.FieldValue; }

  // Stan aplikacji (tablice) ⇄ dokument meta w chmurze (mapy)
  // Udziały pożyczki (funds) nie są synchronizowane — każde urządzenie liczy je z historii wpisów
  function loanOut(l) {
    return { id: l.id, name: String(l.name), amount: n(l.amount), since: n(l.since) || null, at: n(l.at) || null, note: l.note || '' };
  }
  function toCloud(s) {
    var loans = {}, cats = {};
    (s.loans || []).forEach(function (l) { if (l && l.id) loans[l.id] = loanOut(l); });
    (s.customCats || []).forEach(function (c) { if (c && c.id) cats[c.id] = clean({ id: c.id, name: c.name, icon: c.icon || 'tag', color: c.color || '#8e8e93' }); });
    var hidden = {};
    (s.hiddenCats || []).forEach(function (id) { if (typeof id === 'string' && id) hidden[id] = true; });
    return { v: 2, cash: n(s.cash), bank: n(s.bank), cashAt: s.cashAt || null, bankAt: s.bankAt || null, loansAt: s.loansAt || null,
      lastFund: s.lastFund || 'cash', loans: loans, cats: cats, hidden: hidden };
  }
  // Odczyt meta z chmury (także starszego formatu z tablicami) do postaci znormalizowanej
  function normCloud(m) {
    m = m || {};
    var loans = {}, cats = {};
    var srcLoans = Array.isArray(m.loans) ? m.loans : Object.keys(m.loans || {}).map(function (k) { var x = m.loans[k] || {}; x.id = x.id || k; return x; });
    srcLoans.forEach(function (l) { if (l && l.id && l.name && n(l.amount) > 0) loans[l.id] = loanOut(l); });
    // Grupy: mapa „cats” (obecny format) + ewentualna stara lista „customCats” (pierwsza wersja) — obie naraz
    var srcCats = Object.keys(m.cats && typeof m.cats === 'object' && !Array.isArray(m.cats) ? m.cats : {}).map(function (k) { var x = m.cats[k] || {}; x.id = x.id || k; return x; });
    if (Array.isArray(m.customCats)) m.customCats.forEach(function (c) { if (c && c.id && !(m.cats && m.cats[c.id])) srcCats.push(c); });
    srcCats.forEach(function (c) { if (c && c.id && c.name) cats[c.id] = clean({ id: c.id, name: c.name, icon: c.icon || 'tag', color: c.color || '#8e8e93' }); });
    var hidden = {};
    if (m.hidden && typeof m.hidden === 'object' && !Array.isArray(m.hidden)) Object.keys(m.hidden).forEach(function (k) { if (m.hidden[k] === true) hidden[k] = true; });
    return { v: 2, cash: n(m.cash), bank: n(m.bank), cashAt: m.cashAt || null, bankAt: m.bankAt || null, loansAt: m.loansAt || null,
      lastFund: m.lastFund || 'cash', loans: loans, cats: cats, hidden: hidden };
  }
  // Wbudowane grupy znane tej wersji aplikacji — grup spoza tej listy (z nowszej/starszej wersji) nie kasujemy w chmurze
  function knownHideable(id) {
    var list = (window.SaldoIcons && window.SaldoIcons.DEFAULT_CATS) || [];
    return id !== 'other' && list.some(function (c) { return c.id === id; });
  }
  // Stary format meta (tablice z pierwszej wersji) — przy najbliższej wysyłce zapisujemy pełne mapy i kasujemy tablice
  var legacyMeta = false, legacyLoans = false;
  function noteLegacy(m) {
    if (!m) return;
    if (Array.isArray(m.customCats) || Array.isArray(m.cats)) legacyMeta = true;
    if (Array.isArray(m.loans)) { legacyMeta = true; legacyLoans = true; }
  }
  function fromCloud(cm, history) {
    var s = {
      cash: cm.cash, bank: cm.bank, cashAt: cm.cashAt, bankAt: cm.bankAt, loansAt: cm.loansAt, lastFund: cm.lastFund,
      loans: Object.keys(cm.loans).map(function (k) { return clean(cm.loans[k]); }),
      customCats: Object.keys(cm.cats).map(function (k) { return clean(cm.cats[k]); }),
      hiddenCats: Object.keys(cm.hidden || {}),
      history: (history || []).slice().sort(function (a, b) { return b.at - a.at; })
    };
    return S.migrate(s);
  }
  function sameData(a, b) {
    if (stable(toCloud(a)) !== stable(toCloud(b))) return false;
    var ha = a.history || [], hb = b.history || [];
    if (ha.length !== hb.length) return false;
    var m = {};
    hb.forEach(function (e) { m[e.id] = stable(clean(e)); });
    return ha.every(function (e) { return m[e.id] === stable(clean(e)); });
  }

  // Skutki wpisu dla stanów (do łączenia danych z dwóch miejsc)
  function effectsOf(e) {
    var fx = { cash: 0, bank: 0, loan: 0, name: null, fund: null };
    var d = n(e.after) - n(e.before);
    if (e.source === 'loan') {
      fx.loan = d; fx.name = e.name;
      if (e.returned) { fx.cash += n(e.returned.cash); fx.bank += n(e.returned.bank); }
      else if (e.mode !== 'set' && (e.fund === 'cash' || e.fund === 'bank')) { fx[e.fund] -= d; fx.fund = e.fund; }
      else fx.fund = 'none';
      return fx;
    }
    if (e.mode === 'move') { fx[e.source] -= n(e.amount); fx[e.to] += n(e.amount); return fx; }
    fx[e.source] += d;
    return fx;
  }

  // ---------- Kopie w telefonie (IndexedDB) ----------
  var idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('brak IndexedDB')); return; }
      var r = indexedDB.open('saldo', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('backups', { keyPath: 'id' }); };
      r.onsuccess = function () {
        var dbh = r.result;
        dbh.onclose = function () { idbP = null; };          // iOS potrafi zamknąć połączenie w tle
        dbh.onversionchange = function () { dbh.close(); idbP = null; };
        res(dbh);
      };
      r.onerror = function () { idbP = null; rej(r.error); };
    });
    return idbP;
  }
  function idbReq(mode, fn) {
    return idb().then(function (dbh) {
      return new Promise(function (res, rej) {
        var tx;
        try { tx = dbh.transaction('backups', mode); } catch (e) { idbP = null; rej(e); return; }
        var out = fn(tx.objectStore('backups'));
        tx.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  function localList() {
    return idbReq('readonly', function (st) { return st.getAll(); }).then(function (all) {
      return (all || []).sort(function (a, b) { return b.at - a.at; });
    }).catch(function () { return []; });
  }
  // Zwraca true, gdy kopia się zapisała
  function localSave(id, s, label) {
    var rec = { id: id, at: Date.now(), label: label || '', json: JSON.stringify(s), summary: summaryOf(s) };
    return idbReq('readwrite', function (st) { return st.put(rec); })
      .then(function () { return localPrune().catch(function () {}); })
      .then(function () { renderBackups(); return true; })
      .catch(function () { return false; });
  }
  function localPrune() {
    return localList().then(function (list) {
      var daily = list.filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.id); });
      var extra = list.filter(function (r) { return !/^\d{4}-\d{2}-\d{2}$/.test(r.id); });
      var drop = daily.slice(LOCAL_KEEP).concat(extra.slice(8));
      if (!drop.length) return;
      return idbReq('readwrite', function (st) { drop.forEach(function (r) { st.delete(r.id); }); });
    });
  }
  var localDoneToday = null;
  function localAutoBackup() {
    var s = S.getState();
    if (S.isEmpty(s)) return Promise.resolve();
    var id = today();
    if (localDoneToday === id) return Promise.resolve();
    return idbReq('readonly', function (st) { return st.get(id); }).then(function (exists) {
      if (exists) { localDoneToday = id; return; }
      return localSave(id, s).then(function (ok) { if (ok) localDoneToday = id; });
    }).catch(function () {});
  }

  // ---------- Chmura ----------
  var auth = null, db = null, user = null;
  var ready = false, reconciling = false, gen = 0, unsubs = [], listenBroken = false;
  var base = null;          // to, co według nas jest w chmurze (meta, znormalizowane)
  var lastEntries = {};     // id → JSON wpisu, który jest w chmurze
  var status = 'local', statusMsg = '', lastSyncAt = null, pending = 0, pushTimer = null, retryTimer = null;

  function startFirebase() {
    try {
      firebase.initializeApp(cfg);
      auth = firebase.auth();
      db = firebase.firestore();
      db.enablePersistence({ synchronizeTabs: true }).catch(function () { /* np. tryb prywatny — działa bez pamięci podręcznej */ });
      statusMsg = '';
      auth.onAuthStateChanged(onUser);
    } catch (e) {
      auth = null;
      statusMsg = 'Nie udało się uruchomić bazy: ' + e.message;
    }
    renderAccount();
  }
  var libsLoading = false;
  function loadFirebase() {
    if (!configured || auth || libsLoading) return;
    if (window.firebase && window.firebase.auth && window.firebase.firestore) { startFirebase(); return; }
    libsLoading = true;
    statusMsg = 'Łączenie z bazą danych…';
    Promise.all(LIBS.map(loadScript)).then(function () {
      libsLoading = false;
      startFirebase();
    }, function () {
      libsLoading = false;
      statusMsg = 'Nie udało się wczytać modułu bazy danych (brak internetu?). Dane zapisują się w tym urządzeniu — synchronizacja ruszy po powrocie internetu.';
      renderAccount();
    });
  }

  function userDoc() { return db.collection('users').doc(user.uid); }
  function metaRef() { return userDoc().collection('data').doc('meta'); }
  function entriesCol() { return userDoc().collection('entries'); }
  function backupsCol() { return userDoc().collection('backups'); }
  function inboxCol() { return userDoc().collection('inbox'); }
  // Prywatna skrzynka dla skrótu: users/{uid}/in_<klucz>. Reguły bazy pozwalają tam dopisać płatność
  // bez logowania, ale tylko znając klucz zapisany w meta (inboxKey) — skrót nie potrzebuje hasła.
  var inboxKey = null;
  function keyCol() { return userDoc().collection('in_' + inboxKey); }
  function newKey() {
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', out = '';
    var r = new Uint32Array(28);
    (window.crypto || window.msCrypto).getRandomValues(r);
    for (var i = 0; i < r.length; i++) out += abc.charAt(r[i] % abc.length);
    return out;
  }
  function ensureInboxKey() {
    if (!user || !ready) return Promise.resolve(null);
    var g = gen;
    var ref = metaRef();
    return db.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var k = snap.exists && snap.data().inboxKey;
        if (typeof k === 'string' && /^[A-Za-z0-9]{20,}$/.test(k)) return k;
        k = newKey();
        tx.set(ref, { inboxKey: k }, { merge: true });
        return k;
      });
    }).then(function (k) {
      if (g !== gen) return null;
      if (k !== inboxKey) { inboxKey = k; listenKeyInbox(); }
      return k;
    }).catch(function () { return null; });
  }
  var keyUnsub = null;
  function listenKeyInbox() {
    if (keyUnsub) { try { keyUnsub(); } catch (e) { /* już odpięte */ } keyUnsub = null; }
    if (!inboxKey || !user || !ready) return;
    var g = gen;
    keyUnsub = keyCol().onSnapshot({ includeMetadataChanges: true }, function (snap) {
      if (!ready || g !== gen || snap.empty) return;
      processInbox(snap.docs.filter(function (d) { return !d.metadata.hasPendingWrites; }));
    }, function () { /* np. brak sieci — wróci przy ponownym nasłuchu */ });
    unsubs.push(function () { if (keyUnsub) { keyUnsub(); keyUnsub = null; } });
  }

  function setStatus(s, msg) { status = s; statusMsg = msg || ''; renderAccount(); }
  function detach() { unsubs.forEach(function (u) { try { u(); } catch (e) { /* już odpięte */ } }); unsubs = []; }
  function setActive(on) { if (S.setSyncActive) S.setSyncActive(on); }

  function primeEntries(hist) {
    lastEntries = {};
    (hist || []).forEach(function (e) { lastEntries[e.id] = stable(clean(e)); });
  }

  // Zapis wielu operacji wpisów w paczkach po 400 (limit Firestore to 500)
  function commitOps(ops) {
    var batches = [];
    for (var i = 0; i < ops.length; i += 400) {
      var b = db.batch();
      ops.slice(i, i + 400).forEach(function (op) {
        if (op.del) b.delete(op.ref); else b.set(op.ref, op.data, op.merge ? { merge: true } : undefined);
      });
      batches.push(b.commit());
    }
    return Promise.all(batches);
  }

  // Różnica meta względem bazy: przyrosty dla kwot, zwykłe wartości dla reszty, usunięcia dla zniknięć
  function metaPatch(cur, b) {
    var p = {}, any = false;
    ['cash', 'bank'].forEach(function (k) { var d = cur[k] - b[k]; if (d) { p[k] = FV().increment(d); any = true; } });
    ['cashAt', 'bankAt', 'loansAt', 'lastFund'].forEach(function (k) { if (cur[k] !== b[k]) { p[k] = cur[k]; any = true; } });
    var lp = {};
    Object.keys(cur.loans).forEach(function (id) {
      var L = cur.loans[id], B = b.loans[id];
      if (!B) { lp[id] = clean(L); return; }
      var x = {}, has = false;
      ['name', 'since', 'at', 'note'].forEach(function (k) { if (L[k] !== B[k]) { x[k] = L[k]; has = true; } });
      if (L.amount !== B.amount) { x.amount = FV().increment(L.amount - B.amount); has = true; }
      if (has) {
        // zawsze z nazwą — jeśli inne urządzenie właśnie usunęło pożyczkę, przyrost utworzy poprawną pozycję
        x.id = L.id; x.name = L.name; x.since = L.since;
        lp[id] = x;
      }
    });
    // Usunięcie pożyczki = przyrost ujemny do zera (nie kasowanie pozycji): jeśli inne urządzenie w tym czasie
    // dopożyczyło, jego kwota zostaje. Pozycje z kwotą 0 są pomijane przy odczycie.
    Object.keys(b.loans).forEach(function (id) {
      if (cur.loans[id]) return;
      var B = b.loans[id];
      lp[id] = { id: B.id, name: B.name, since: B.since, amount: FV().increment(-B.amount) };
    });
    if (Object.keys(lp).length) { p.loans = lp; any = true; }
    var cp = {};
    Object.keys(cur.cats).forEach(function (id) { if (stable(cur.cats[id]) !== stable(b.cats[id] || null)) cp[id] = clean(cur.cats[id]); });
    Object.keys(b.cats).forEach(function (id) { if (!cur.cats[id]) cp[id] = FV().delete(); });
    if (Object.keys(cp).length) { p.cats = cp; any = true; }
    // Usunięte wbudowane grupy: osobne klucze mapy (usunięcie na jednym urządzeniu nie kasuje drugiego)
    var hp = {}, ch = cur.hidden || {}, bh = b.hidden || {};
    Object.keys(ch).forEach(function (id) { if (!bh[id]) hp[id] = true; });
    Object.keys(bh).forEach(function (id) { if (!ch[id] && knownHideable(id)) hp[id] = FV().delete(); });
    if (Object.keys(hp).length) { p.hidden = hp; any = true; }
    if (!any) return null;
    p.v = 2;
    p.updatedAt = FV().serverTimestamp();
    return p;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { if (user && ready) pushChanges(); }, 20000);
  }

  // Wyślij do chmury tylko to, co się zmieniło. Wysyłki idą po kolei (jedna naraz), więc przy błędzie
  // można bezpiecznie cofnąć dokładnie tę jedną wysyłkę i spróbować ponownie.
  var pushing = false, pushAgain = false, deferredRemote = null;
  function pushChanges() {
    if (!user || !ready || !base) return;
    if (pushing) { pushAgain = true; return; }
    var g = gen;
    var s = S.getState();
    var cur, patch, ops = [], touched = {};
    var prevBase = base;
    try {
      cur = toCloud(s);
      patch = metaPatch(cur, base);
      var seen = {};
      var oldestLocal = (s.history || []).length ? s.history[s.history.length - 1].at : 0;
      var trimmed = (s.history || []).length >= 5000;
      (s.history || []).forEach(function (e) {
        seen[e.id] = 1;
        var j = stable(clean(e));
        if (lastEntries[e.id] !== j) { ops.push({ ref: entriesCol().doc(e.id), data: clean(e), id: e.id, json: j }); }
      });
      Object.keys(lastEntries).forEach(function (id) {
        if (seen[id]) return;
        // Przy obciętej historii (limit 5000) nie kasuj w chmurze najstarszych wpisów
        if (trimmed) { try { if (JSON.parse(lastEntries[id]).at < oldestLocal) return; } catch (e) { /* zwykłe usunięcie */ } }
        ops.push({ ref: entriesCol().doc(id), del: true, id: id });
      });
    } catch (e) {
      setStatus('error', errText(e));
      return;
    }
    var cleaning = legacyMeta;
    if (cleaning) {
      // Jednorazowo: pełne mapy grup (i pożyczek, jeśli były tablicą) + usunięcie starych tablic
      patch = patch || { v: 2, updatedAt: FV().serverTimestamp() };
      patch.cats = Object.assign(clean(cur.cats), patch.cats || {});
      if (legacyLoans) patch.loans = clean(cur.loans);
      patch.customCats = FV().delete();
    }
    if (!patch && !ops.length) return;
    // Optymistycznie: baza i wpisy oznaczone jako wysłane (przy błędzie cofamy tylko tę wysyłkę)
    if (patch) base = clean(cur);
    ops.forEach(function (o) { touched[o.id] = lastEntries[o.id]; if (o.del) delete lastEntries[o.id]; else lastEntries[o.id] = o.json; });
    pushing = true; pending++;
    setStatus(navigator.onLine === false ? 'offline' : 'syncing');
    var metaOk = true;
    var jobs = [];
    if (patch) jobs.push(metaRef().set(patch, { merge: true }).catch(function (e) { metaOk = false; throw e; }));
    if (ops.length) jobs.push(commitOps(ops.map(function (o) { return { ref: o.ref, data: o.data, del: o.del }; })).catch(function (e) {
      if (g === gen) Object.keys(touched).forEach(function (id) { if (touched[id] === undefined) delete lastEntries[id]; else lastEntries[id] = touched[id]; });
      throw e;
    }));
    var settle = function () {
      pushing = false; pending = Math.max(0, pending - 1);
      if (g !== gen) return;
      if (deferredRemote) { var r = deferredRemote; deferredRemote = null; applyRemoteMeta(r); }
      if (pushAgain) { pushAgain = false; setTimeout(pushChanges, 0); }
    };
    Promise.all(jobs).then(function () {
      if (g !== gen) { settle(); return; }
      if (cleaning) { legacyMeta = false; legacyLoans = false; }
      lastSyncAt = Date.now();
      settle();
      if (!pending && !pushing) setStatus(listenBroken ? 'error' : 'ok', listenBroken ? 'Utracono połączenie na żywo z bazą — stuknij „Połącz ponownie”.' : '');
    }).catch(function (e) {
      if (g === gen && !metaOk) base = prevBase;   // jedyna wysyłka w toku — cofnięcie jest dokładne
      settle();
      if (g !== gen) return;
      setStatus(navigator.onLine === false ? 'offline' : 'error', errText(e));
      scheduleRetry();
    });
  }

  // Zapisz w chmurze dane z urządzenia.
  // cm — meta odczytane z chmury: wtedy zapisujemy tylko RÓŻNICĘ (przyrosty), żeby nie skasować zmian,
  // które inne urządzenie wysłało w międzyczasie. Wpisy, których lokalnie nie ma (cloudIds), są usuwane.
  function replaceCloud(s, cloudIds, cm, g) {
    var full = toCloud(s);
    var metaJob;
    if (cm) {
      var patch = metaPatch(full, cm);
      metaJob = patch ? metaRef().set(patch, { merge: true }) : Promise.resolve();
    } else {
      var data = clean(full);
      data.updatedAt = FV().serverTimestamp();
      metaJob = metaRef().set(data);
    }
    var ops = [];
    var local = {};
    (s.history || []).forEach(function (e) { local[e.id] = 1; ops.push({ ref: entriesCol().doc(e.id), data: clean(e) }); });
    (cloudIds || []).forEach(function (id) { if (!local[id]) ops.push({ ref: entriesCol().doc(id), del: true }); });
    return Promise.all([metaJob, commitOps(ops)]).then(function () {
      if (g !== undefined && g !== gen) return;
      // baza = to, co wysłaliśmy; zmiany innych urządzeń dojdą przez nasłuch (różnica server − baza)
      base = clean(full); primeEntries(s.history); lastSyncAt = Date.now();
    });
  }

  // Połącz dane z urządzenia i z chmury: wszystkie wpisy z obu stron, a stany z chmury + skutki wpisów, których chmura nie zna
  function mergeStates(local, cloud) {
    var cloudIds = {};
    (cloud.history || []).forEach(function (e) { cloudIds[e.id] = 1; });
    var extra = (local.history || []).filter(function (e) { return !cloudIds[e.id]; });
    var m = clean(cloud);
    var loansByName = {};
    m.loans.forEach(function (l) { loansByName[String(l.name).toLowerCase()] = l; });
    // pożyczki z urządzenia, których chmura nie ma (po nazwie)
    (local.loans || []).forEach(function (l) {
      var k = String(l.name).toLowerCase();
      if (!loansByName[k]) { var c = clean(l); c.amount = 0; m.loans.push(c); loansByName[k] = c; }
    });
    extra.slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (e) {
      var fx = effectsOf(e);
      m.cash += fx.cash; m.bank += fx.bank;
      if (fx.name) {
        var L = loansByName[String(fx.name).toLowerCase()];
        if (!L) { L = { id: 'm' + e.id, name: fx.name, amount: 0, since: e.at, note: '' }; m.loans.push(L); loansByName[String(fx.name).toLowerCase()] = L; }
        L.amount = Math.max(0, L.amount + fx.loan);
      }
    });
    m.loans = m.loans.filter(function (l) { return l.amount > 0; });
    m.loans.forEach(function (l) { l.funds = null; });   // udziały policzy aplikacja z historii
    var catIds = {};
    m.customCats.forEach(function (c) { catIds[c.id] = 1; });
    (local.customCats || []).forEach(function (c) { if (!catIds[c.id]) m.customCats.push(clean(c)); });
    m.hiddenCats = (m.hiddenCats || []).concat((local.hiddenCats || []).filter(function (id) { return (m.hiddenCats || []).indexOf(id) === -1; }));
    m.history = (cloud.history || []).concat(extra).sort(function (a, b) { return b.at - a.at; });
    ['cashAt', 'bankAt', 'loansAt'].forEach(function (k) { m[k] = Math.max(local[k] || 0, cloud[k] || 0) || null; });
    return S.migrate(m);
  }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }

  // Pytanie z wyborem; zamknięcie bez wyboru (Anuluj / tło / Escape) daje 'cancel'
  function ask(title, buttons) {
    return new Promise(function (res) {
      S.actionChoices(title, buttons.map(function (b) { return { text: b.text, danger: b.danger, bold: b.bold, cb: function () { res(b.value); } }; }),
        function () { res('cancel'); });
    });
  }

  // Po zalogowaniu: połącz dane z tego urządzenia z chmurą
  function onUser(u) {
    gen++;
    detach();
    clearTimeout(retryTimer);
    user = u; ready = false; reconciling = false; base = null; lastEntries = {}; listenBroken = false; pending = 0;
    pushAgain = false; deferredRemote = null; inboxBusy = {}; inboxKey = null; keyUnsub = null;
    legacyMeta = false; legacyLoans = false;
    setActive(false);
    renderAccount();
    if (!u) { setStatus(configured ? 'signedOut' : 'local'); renderBackups(); return; }
    reconcile();
  }
  function reconcile() {
    if (!user || reconciling) return;
    var g = gen;
    reconciling = true;
    setStatus('syncing');
    var alive = function () { return g === gen; };
    Promise.all([metaRef().get(), entriesCol().get()]).then(function (r) {
      if (!alive()) return 'stale';
      var metaSnap = r[0], entSnap = r[1];
      var local = S.getState();
      var cloudHist = entSnap.docs.map(function (d) { return clean(d.data()); });
      var cloudIds = entSnap.docs.map(function (d) { return d.id; });
      if (!metaSnap.exists && entSnap.empty) {
        // Chmura pusta — wyślij dane z tego urządzenia
        var now0 = S.getState();
        return replaceCloud(now0, [], null, g).then(function () { if (alive() && !S.isEmpty(now0)) S.toast('Dane zapisane w chmurze', 'success'); });
      }
      noteLegacy(metaSnap.data());
      var cm = normCloud(metaSnap.data());
      var cloud = fromCloud(cm, cloudHist);
      if (S.isEmpty(local) || sameData(local, cloud)) {
        base = clean(toCloud(cloud)); primeEntries(cloud.history);
        S.replaceState(cloud, { silent: true });
        return;
      }
      var inCloud = {}; cloud.history.forEach(function (e) { inCloud[e.id] = 1; });
      var inLocal = {}; local.history.forEach(function (e) { inLocal[e.id] = 1; });
      var onlyLocal = local.history.filter(function (e) { return !inCloud[e.id]; }).length;
      var onlyCloud = cloud.history.filter(function (e) { return !inLocal[e.id]; }).length;
      var merged = mergeStates(local, cloud);
      return ask('Dane na tym urządzeniu różnią się od danych w chmurze.\nW chmurze: ' + S.money(S.total(cloud)) + ' (' + S.plural(cloud.history.length, 'wpis', 'wpisy', 'wpisów') + ', ' + onlyCloud + ' tylko tam).\n' +
        'Na urządzeniu: ' + S.money(S.total(local)) + ' (' + S.plural(local.history.length, 'wpis', 'wpisy', 'wpisów') + ', ' + onlyLocal + ' tylko tu).\n' +
        'Połączenie zachowa wpisy z obu miejsc (razem ' + S.money(S.total(merged)) + '). Wersja, którą zastąpisz, zostanie zapisana jako kopia.', [
        { text: 'Połącz dane', bold: true, value: 'merge' },
        { text: 'Użyj danych z chmury', value: 'cloud' },
        { text: 'Wyślij dane z tego urządzenia', value: 'local' }
      ]).then(function (choice) {
        if (!alive()) return 'stale';
        if (choice === 'cancel') throw { code: 'choice' };
        // Najpierw kopie bezpieczeństwa obu wersji — bez udanej kopii niczego nie nadpisujemy
        return Promise.all([
          localSave('przed-polaczeniem-' + Date.now(), local, 'Dane z urządzenia przed połączeniem z chmurą'),
          withTimeout(cloudBackup(cloud, 'przed-' + Date.now(), 'Dane z chmury przed połączeniem'), 8000).then(function () { return true; }, function () { return false; })
        ]).then(function (ok) {
          if (!alive()) return 'stale';
          if (!ok[0] && !ok[1]) throw { code: 'backup' };
          if (choice === 'cloud') {
            base = clean(toCloud(cloud)); primeEntries(cloud.history);
            S.replaceState(cloud, { silent: true });
            return;
          }
          // Bieżący stan — uwzględnia zmiany zrobione w trakcie pytania i zapisu kopii
          var now = S.getState();
          var next = choice === 'merge' ? mergeStates(now, cloud) : now;
          return replaceCloud(next, cloudIds, cm, g).then(function () { if (alive()) S.replaceState(next, { silent: true }); });
        });
      });
    }).then(function (res) {
      if (!alive() || res === 'stale') return;
      ready = true;
      reconciling = false;
      setActive(true);
      listen();
      recoverClaims();
      ensureInboxKey();
      lastSyncAt = Date.now();
      setStatus('ok');
      renderBackups();
      cloudAutoBackup();
      pushChanges();
    }).catch(function (e) {
      if (!alive()) return;
      reconciling = false;
      setStatus(navigator.onLine === false ? 'offline' : 'error', errText(e));
    });
  }

  // Zmiany z innych urządzeń (na żywo), łączone z niewysłanymi zmianami lokalnymi
  function applyRemoteMeta(server) {
    var s = S.getState();
    var cur = toCloud(s);
    var b = base;
    var out = clean(server);
    // kwoty: wartość z chmury + to, czego jeszcze nie wysłaliśmy
    ['cash', 'bank'].forEach(function (k) { out[k] = server[k] + (cur[k] - b[k]); });
    ['cashAt', 'bankAt', 'loansAt', 'lastFund'].forEach(function (k) { if (cur[k] !== b[k]) out[k] = cur[k]; });
    // pożyczki
    Object.keys(cur.loans).forEach(function (id) {
      var L = cur.loans[id], B = b.loans[id], R = server.loans[id];
      if (!B) { if (!R) out.loans[id] = clean(L); return; }          // nowa lokalna, niewysłana
      if (!R) {
        // usunięta zdalnie: zostaje tylko to, co dopożyczono lokalnie (tyle samo dopisze przyrost w chmurze)
        var dl = L.amount - B.amount;
        if (dl > 0) { var y = clean(L); y.amount = dl; out.loans[id] = y; }
        return;
      }
      var x = clean(R);
      ['name', 'since', 'at', 'note'].forEach(function (k) { if (L[k] !== B[k]) x[k] = L[k]; });
      x.amount = R.amount + (L.amount - B.amount);
      out.loans[id] = x;
    });
    Object.keys(b.loans).forEach(function (id) {
      if (cur.loans[id] || !out.loans[id]) return;
      // usunięta lokalnie: zostaje tylko to, co w międzyczasie zmieniło inne urządzenie
      var dr = server.loans[id].amount - b.loans[id].amount;
      if (dr > 0) out.loans[id].amount = dr; else delete out.loans[id];
    });
    Object.keys(out.loans).forEach(function (id) { if (!(out.loans[id].amount > 0)) delete out.loans[id]; });
    // grupy
    Object.keys(cur.cats).forEach(function (id) { if (!b.cats[id] || stable(cur.cats[id]) !== stable(b.cats[id])) out.cats[id] = clean(cur.cats[id]); });
    Object.keys(b.cats).forEach(function (id) { if (!cur.cats[id]) delete out.cats[id]; });
    // usunięte wbudowane grupy: z chmury + niewysłane zmiany lokalne
    out.hidden = out.hidden || {};
    var ch = cur.hidden || {}, bh = b.hidden || {};
    Object.keys(ch).forEach(function (id) { if (!bh[id]) out.hidden[id] = true; });
    Object.keys(bh).forEach(function (id) { if (!ch[id] && knownHideable(id)) delete out.hidden[id]; });
    base = clean(server);
    var next = fromCloud(out, s.history);
    if (stable(toCloud(next)) !== stable(cur)) S.replaceState(next, { silent: true });
    lastSyncAt = Date.now(); renderAccount();
  }

  function onListenError(e) {
    listenBroken = true;
    setStatus('error', (e && e.code === 'permission-denied') ? errText(e) : 'Utracono połączenie na żywo z bazą — stuknij „Połącz ponownie”.');
  }
  function listen() {
    detach();
    listenBroken = false;
    var g = gen;
    unsubs.push(inboxCol().onSnapshot({ includeMetadataChanges: true }, function (snap) {
      if (!ready || g !== gen || snap.empty) return;
      processInbox(snap.docs.filter(function (d) { return !d.metadata.hasPendingWrites; }));
    }, function () { /* skrzynka opcjonalna */ }));
    listenKeyInbox();
    unsubs.push(metaRef().onSnapshot({ includeMetadataChanges: true }, function (snap) {
      if (!ready || g !== gen || snap.metadata.hasPendingWrites || !snap.exists || !base) return;
      noteLegacy(snap.data());
      if (legacyMeta && !pushing) setTimeout(pushChanges, 0);
      var server = normCloud(snap.data());
      if (stable(server) === stable(base)) { deferredRemote = null; return; }
      if (pushing) { deferredRemote = server; return; }   // zastosuj po zakończeniu wysyłki
      applyRemoteMeta(server);
    }, onListenError));
    var authoritative = false;
    unsubs.push(entriesCol().onSnapshot({ includeMetadataChanges: true }, function (snap) {
      if (!ready || g !== gen) return;
      var s = S.getState();
      var hist = (s.history || []).slice();
      var idx = {};
      hist.forEach(function (e, i) { idx[e.id] = i; });
      var changed = false;
      // Pierwszy pełny odczyt z serwera: wpisy usunięte w chmurze, gdy nasłuch nie działał, znikają też tutaj
      if (!authoritative && !snap.metadata.fromCache) {
        authoritative = true;
        var present = {};
        snap.docs.forEach(function (d) { present[d.id] = 1; });
        Object.keys(lastEntries).forEach(function (id) {
          if (present[id]) return;
          var i = idx[id];
          var loc = i !== undefined ? hist[i] : null;
          if (loc && stable(clean(loc)) !== lastEntries[id]) return;   // zmieniony lokalnie — wyśle się ponownie
          delete lastEntries[id];
          if (loc) { hist = hist.filter(function (e) { return e.id !== id; }); changed = true; }
        });
        idx = {}; hist.forEach(function (e, i2) { idx[e.id] = i2; });
      }
      snap.docChanges().forEach(function (ch) {
        if (ch.doc.metadata.hasPendingWrites) return;      // własny, jeszcze niezapisany na serwerze
        var id = ch.doc.id;
        var local = idx[id] !== undefined ? hist[idx[id]] : null;
        var localDirty = local && stable(clean(local)) !== lastEntries[id];   // lokalna zmiana czeka na wysłanie
        if (ch.type === 'removed') {
          if (lastEntries[id] === undefined) return;
          delete lastEntries[id];
          if (local && !localDirty) { hist = hist.filter(function (e) { return e.id !== id; }); changed = true; }
          return;
        }
        var data = clean(ch.doc.data());
        var j = stable(data);
        if (lastEntries[id] === j) return;
        if (localDirty) return;                              // lokalna wersja wygra przy wysłaniu
        lastEntries[id] = j;
        if (local) hist[idx[id]] = data; else hist.push(data);
        changed = true;
      });
      if (!changed) return;
      hist.sort(function (a, b) { return b.at - a.at; });
      S.replaceState(Object.assign({}, s, { history: hist }), { silent: true });
      lastSyncAt = Date.now(); renderAccount();
    }, onListenError));
  }

  // ---------- Skrzynka płatności (Apple Pay ze Skrótów) ----------
  // Skrót iOS dopisuje dokument do users/{uid}/inbox: { amount: "24,50 zł", merchant: "Orlen", card: "..." }.
  // Aplikacja zamienia go w wydatek z konta (id „ap_<id dokumentu>” — bez duplikatów między urządzeniami) i usuwa ze skrzynki.
  function parseMoneyText(v) {
    if (typeof v === 'number') return Math.round(Math.abs(v) * 100);
    var raw = String(v || '').replace(/[^\d.,]/g, '');
    if (!raw) return NaN;
    var last = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
    var intPart = raw, frac = '';
    // separator dziesiętny tylko gdy po nim są 1–2 cyfry (inaczej to separator tysięcy)
    if (last >= 0 && raw.length - last - 1 <= 2) { intPart = raw.slice(0, last); frac = raw.slice(last + 1); }
    intPart = intPart.replace(/[.,]/g, '');
    var v2 = Number(intPart || '0') * 100 + Number((frac + '00').slice(0, 2));
    return isFinite(v2) ? v2 : NaN;
  }
  function parseWhen(v) {
    if (typeof v === 'number' && v > 1e11) return v;
    if (v && typeof v.toMillis === 'function') return v.toMillis();
    var t = Date.parse(v);
    return isFinite(t) && t > 0 && t <= Date.now() + 86400000 ? t : Date.now();
  }
  // Płatność przejmuje dokładnie jedno urządzenie: zdejmuje ją ze skrzynki w transakcji bazy.
  // Gdy dwa urządzenia są otwarte jednocześnie, drugie zobaczy, że dokumentu już nie ma, i nic nie zrobi.
  var inboxBusy = {};
  var claimed = [];
  var claimTimer = null;
  function announce() {
    var added = claimed; claimed = [];
    if (added.length === 1) {
      var a = added[0];
      S.showDone(a.merchant + ': ' + S.money(a.amount) + ' · ' + S.catName(a.cat));
    } else if (added.length > 1) {
      S.showDone('Dopisano ' + S.plural(added.length, 'płatność', 'płatności', 'płatności') + ' Apple Pay');
    }
  }
  function claimsCol() { return userDoc().collection('inboxClaims'); }
  // Zamień przejętą płatność w wydatek (bezpiecznie wielokrotnie: id „ap_<id>” nie zdubluje wpisu)
  function applyPayment(id, x) {
    var amount = parseMoneyText(x.amount);
    var merchant = String(x.merchant || x.name || '').trim().slice(0, 60);
    if (!(amount > 0)) {
      S.toast('Nie rozpoznano kwoty płatności Apple Pay' + (merchant ? ' (' + merchant + ')' : '') + ' — dopisz ją ręcznie', 'info');
      return;
    }
    var cat = S.guessCat(merchant);
    var ok = S.addExternalExpense({ id: 'ap_' + id, source: 'bank', amount: amount, cat: cat, note: merchant || 'Apple Pay', at: parseWhen(x.at), via: 'applepay' });
    if (ok) {
      claimed.push({ merchant: merchant || 'Apple Pay', amount: amount, cat: cat });
      clearTimeout(claimTimer);
      claimTimer = setTimeout(announce, 300);
    }
  }
  // Płatność przejmuje jedno urządzenie: w jednej transakcji zdejmuje ją ze skrzynki i zapisuje „potwierdzenie
  // przejęcia” ze swoim identyfikatorem. Jeśli odpowiedź bazy zaginie (zerwane połączenie), urządzenie
  // znajdzie później swoje potwierdzenie i dopisze płatność — nic nie przepada i nic się nie dubluje.
  function processInbox(docs) {
    var g = gen;
    docs.slice().sort(function (a, b) { return parseWhen((a.data() || {}).at) - parseWhen((b.data() || {}).at); }).forEach(function (d) {
      if (inboxBusy[d.id]) return;
      inboxBusy[d.id] = 1;
      var claimRef = claimsCol().doc(d.id);
      db.runTransaction(function (tx) {
        return tx.get(d.ref).then(function (snap) {
          if (!snap.exists) return null;           // przejęte przez inne urządzenie
          var data = snap.data() || {};
          tx.delete(d.ref);
          tx.set(claimRef, { device: deviceId, at: Date.now(), data: clean(data) });
          return data;
        });
      }).then(function (x) {
        if (!x || g !== gen) return;
        applyPayment(d.id, x);
        claimRef.delete().catch(function () {});
      }).catch(function () {
        delete inboxBusy[d.id];                     // np. offline — spróbuje przy następnej zmianie skrzynki
        if (g === gen) setTimeout(recoverClaims, 5000);
      });
    });
  }
  // Potwierdzenia tego urządzenia, których płatności nie zdążyły się dopisać
  function recoverClaims() {
    if (!user || !ready) return;
    var g = gen;
    claimsCol().where('device', '==', deviceId).get().then(function (q) {
      if (g !== gen) return;
      q.docs.forEach(function (d) {
        applyPayment(d.id, (d.data() || {}).data || {});
        d.ref.delete().catch(function () {});
      });
    }).catch(function () {});
  }

  // ---------- Kopie w chmurze ----------
  function chunks(str) {
    var out = [], i = 0;
    while (i < str.length) {
      var end = Math.min(str.length, i + CHUNK);
      var c = str.charCodeAt(end - 1);
      if (end < str.length && c >= 0xd800 && c <= 0xdbff) end--; // nie dziel par zastępczych (emoji itp.)
      out.push(str.slice(i, end));
      i = end;
    }
    return out.length ? out : [''];
  }
  function cloudBackup(s, id, label) {
    var parts = chunks(JSON.stringify(s));
    var ref = backupsCol().doc(id);
    var ops = parts.map(function (p, i) { return { ref: ref.collection('parts').doc('p' + i), data: { i: i, data: p } }; });
    // nagłówek na końcu — kopia jest widoczna dopiero, gdy wszystkie części są zapisane
    return commitOps(ops).then(function () {
      return ref.set({ at: Date.now(), label: label || '', parts: parts.length, summary: summaryOf(s), createdAt: FV().serverTimestamp() });
    });
  }
  function cloudList() {
    if (!user || !ready) return Promise.resolve([]);
    return backupsCol().get().then(function (q) {
      return q.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }).sort(function (a, b) { return b.at - a.at; });
    }).catch(function () { return []; });
  }
  function cloudDelete(id) {
    var ref = backupsCol().doc(id);
    return ref.collection('parts').get().then(function (q) {
      return commitOps(q.docs.map(function (d) { return { ref: d.ref, del: true }; }).concat([{ ref: ref, del: true }]));
    });
  }
  function cloudPrune() {
    return cloudList().then(function (list) {
      var daily = list.filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.id); });
      var extra = list.filter(function (r) { return !/^\d{4}-\d{2}-\d{2}$/.test(r.id); });
      return Promise.all(daily.slice(CLOUD_KEEP).concat(extra.slice(8)).map(function (r) { return cloudDelete(r.id); }));
    });
  }
  function cloudLoad(rec) {
    var ref = backupsCol().doc(rec.id);
    return ref.collection('parts').get().then(function (q) {
      var parts = q.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return a.i - b.i; });
      if (parts.length < (rec.parts || 1)) throw new Error('niekompletna kopia');
      return JSON.parse(parts.map(function (p) { return p.data; }).join(''));
    });
  }
  var cloudDoneToday = null, backupBusy = false;
  function cloudAutoBackup(force) {
    if (!user || !ready) return Promise.resolve();
    var s = S.getState();
    if (S.isEmpty(s)) { if (force) S.toast('Brak danych do skopiowania', 'info'); return Promise.resolve(); }
    if (force && navigator.onLine === false) { S.toast('Brak internetu — kopia w chmurze powstanie później', 'info'); return Promise.resolve(); }
    var id = today();
    if (!force && cloudDoneToday === id) return Promise.resolve();
    if (backupBusy) return Promise.resolve();
    backupBusy = true; renderAccount();
    return backupsCol().doc(id).get().then(function (d) {
      if (d.exists && !force) { cloudDoneToday = id; return; }
      return cloudBackup(s, id).then(function () { cloudDoneToday = id; return cloudPrune(); })
        .then(function () { renderBackups(); if (force) S.showDone('Kopia zapisana w chmurze'); });
    }).catch(function (e) { if (force) S.toast('Nie udało się zapisać kopii: ' + errText(e), 'info'); })
      .then(function () { backupBusy = false; renderAccount(); });
  }

  // ---------- Komunikaty ----------
  function errText(e) {
    var code = (e && e.code) || '';
    var map = {
      'auth/invalid-email': 'Nieprawidłowy adres e-mail.',
      'auth/missing-email': 'Wpisz adres e-mail.',
      'auth/missing-password': 'Wpisz hasło.',
      'auth/user-not-found': 'Nieprawidłowy e-mail lub hasło.',
      'auth/wrong-password': 'Nieprawidłowy e-mail lub hasło.',
      'auth/invalid-credential': 'Nieprawidłowy e-mail lub hasło.',
      'auth/invalid-login-credentials': 'Nieprawidłowy e-mail lub hasło.',
      'auth/email-already-in-use': 'Konto z tym adresem już istnieje — zaloguj się.',
      'auth/weak-password': 'Hasło musi mieć co najmniej 6 znaków.',
      'auth/network-request-failed': 'Brak połączenia z internetem.',
      'auth/too-many-requests': 'Zbyt wiele prób. Spróbuj ponownie za chwilę.',
      'auth/operation-not-allowed': 'Logowanie e-mailem jest wyłączone w bazie.',
      'auth/requires-recent-login': 'Zaloguj się ponownie i powtórz.',
      'permission-denied': 'Brak dostępu do danych w chmurze. Wyloguj się i zaloguj ponownie.',
      'unauthenticated': 'Sesja wygasła. Zaloguj się ponownie.',
      'unavailable': 'Brak połączenia z bazą — zmiany zapiszą się później.',
      'deadline-exceeded': 'Baza nie odpowiada — spróbuj ponownie za chwilę.',
      'resource-exhausted': 'Dzienny limit bazy został wyczerpany — zmiany zapiszą się jutro.',
      'choice': 'Synchronizacja wstrzymana: wybierz, które dane zachować (stuknij „Połącz z chmurą”).',
      'backup': 'Nie udało się zapisać kopii bezpieczeństwa, więc niczego nie nadpisano. Spróbuj ponownie.'
    };
    return map[code] || ('Wystąpił błąd' + (code ? ' (' + code + ')' : '') + '. Spróbuj ponownie.');
  }

  // ---------- Karta „Konto” ----------
  var el = {
    syncCard: $('syncCard'), syncIcon: $('syncIcon'), syncTitle: $('syncTitle'), syncSub: $('syncSub'),
    authBox: $('authBox'), authEmail: $('authEmail'), authPass: $('authPass'), authError: $('authError'),
    authLogin: $('authLogin'), authRegister: $('authRegister'), authReset: $('authReset'), authNote: $('authNote'),
    userBox: $('userBox'), userAvatar: $('userAvatar'), userEmail: $('userEmail'), userSub: $('userSub'),
    syncNow: $('syncNow'), authLogout: $('authLogout'),
    autoBackups: $('autoBackups'), autoBackupsEmpty: $('autoBackupsEmpty'), tabDot: $('tabDot')
  };

  function renderAccount() {
    var st = status;
    var canAuth = configured && !!auth;
    if (!canAuth) st = 'local';
    else if (!user && st !== 'error') st = 'signedOut';
    var info = {
      local: ['cloudOff', 'gray', 'Tylko na tym urządzeniu', statusMsg || 'Dane i kopie automatyczne są zapisywane w tym urządzeniu.'],
      signedOut: ['cloudOff', 'gray', 'Tylko na tym urządzeniu', 'Zaloguj się, aby mieć te same dane na telefonie i komputerze oraz kopie w chmurze.'],
      syncing: ['refresh', 'blue', 'Synchronizowanie…', reconciling ? 'Łączenie z chmurą.' : 'Zapisywanie zmian w chmurze.'],
      ok: ['cloudCheck', 'green', 'Zsynchronizowano', lastSyncAt ? 'Ostatnio: ' + S.when(lastSyncAt).toLowerCase() : 'Dane są aktualne w chmurze.'],
      offline: ['cloudOff', 'orange', 'Offline', 'Zmiany są zapisane w telefonie i wyślą się do chmury po połączeniu z internetem.'],
      error: ['alert', 'red', 'Problem z synchronizacją', statusMsg]
    }[st] || ['cloudOff', 'gray', 'Tylko na tym urządzeniu', ''];
    el.syncIcon.className = 'sync-icon sync-icon--' + info[1] + (st === 'syncing' ? ' is-spinning' : '');
    el.syncIcon.innerHTML = icon(info[0]);
    el.syncTitle.textContent = info[2];
    el.syncSub.textContent = info[3];
    el.syncSub.hidden = !info[3];
    el.tabDot.hidden = !(user && (st === 'error' || st === 'offline'));
    el.tabDot.className = 'tab-dot tab-dot--' + (st === 'error' ? 'red' : 'orange');

    el.authBox.hidden = !!user;
    el.userBox.hidden = !user;
    [el.authLogin, el.authRegister, el.authReset, el.authEmail, el.authPass].forEach(function (x) { x.disabled = !canAuth || busy; });
    el.authNote.textContent = canAuth
      ? 'Po zalogowaniu te same dane są na telefonie i komputerze, zmiany synchronizują się na bieżąco (także po powrocie internetu), a w chmurze codziennie powstaje kopia zapasowa.'
      : (configured ? 'Logowanie będzie dostępne, gdy aplikacja połączy się z internetem.' : 'Logowanie będzie dostępne po podłączeniu bazy danych.');
    if (user) {
      el.userEmail.textContent = user.email || 'Konto';
      el.userAvatar.textContent = (user.email || '?').charAt(0).toUpperCase();
      var label, sub;
      if (reconciling) { sub = 'Łączenie z chmurą…'; label = 'Łączenie…'; }
      else if (!ready) { sub = 'Synchronizacja wstrzymana'; label = 'Połącz z chmurą'; }
      else if (listenBroken) { sub = 'Brak połączenia na żywo'; label = 'Połącz ponownie'; }
      else { sub = 'Synchronizacja włączona'; label = backupBusy ? 'Tworzenie kopii…' : 'Utwórz kopię w chmurze teraz'; }
      el.userSub.textContent = sub;
      el.syncNow.querySelector('.row-title').textContent = label;
      el.syncNow.disabled = reconciling || backupBusy;
    }
  }

  var backupsRendering = null, backupsAgain = false;
  function renderBackups() {
    if (backupsRendering) { backupsAgain = true; return backupsRendering; } // odśwież jeszcze raz po bieżącym
    backupsRendering = Promise.all([cloudList(), localList()]).then(function (r) {
      backupsRendering = null;
      if (backupsAgain) { backupsAgain = false; setTimeout(renderBackups, 0); }
      var rows = [];
      r[0].forEach(function (b) { rows.push({ kind: 'cloud', rec: b }); });
      r[1].forEach(function (b) { rows.push({ kind: 'local', rec: b }); });
      rows.sort(function (a, b) { return b.rec.at - a.rec.at; });
      el.autoBackupsEmpty.hidden = rows.length > 0;
      el.autoBackups.hidden = rows.length === 0;
      el.autoBackups.innerHTML = rows.slice(0, 40).map(function (x, i) {
        var s = x.rec.summary || {};
        var where = x.kind === 'cloud' ? 'W chmurze' : 'W telefonie';
        var title = x.rec.label || S.fullDate(x.rec.at);
        return '<li><button class="row" data-backup="' + i + '">' +
          '<span class="row-icon ' + (x.kind === 'cloud' ? 'row-icon--blue' : 'row-icon--gray') + '">' + icon(x.kind === 'cloud' ? 'cloud' : 'smartphoneData') + '</span>' +
          '<span class="row-body"><span class="row-title">' + esc(title) + '</span>' +
          '<span class="row-sub">' + where + (x.rec.label ? ' · ' + esc(S.fullDate(x.rec.at)) : '') + ' · ' + S.plural(s.entries || 0, 'wpis', 'wpisy', 'wpisów') + '</span></span>' +
          '<span class="row-value amount">' + S.money(s.total || 0) + '</span>' +
          '</button></li>';
      }).join('');
      el.autoBackups._rows = rows;
    }).catch(function () { backupsRendering = null; });
    return backupsRendering;
  }

  function restore(row) {
    var load = row.kind === 'cloud' ? cloudLoad(row.rec) : Promise.resolve().then(function () { return JSON.parse(row.rec.json); });
    load.then(function (data) {
      var next = S.migrate(data);
      S.confirmAction('Przywrócić kopię z ' + S.fullDate(row.rec.at) + ' (' + S.money(S.total(next)) + ', ' + S.plural(next.history.length, 'wpis', 'wpisy', 'wpisów') +
        ')? Obecne dane zostaną zastąpione — wcześniej zapiszę ich kopię.', 'Przywróć kopię', function () {
        var cur = S.getState();
        var saves = [localSave('przed-przywroceniem-' + Date.now(), cur, 'Dane sprzed przywrócenia kopii')];
        if (user && ready) saves.push(cloudBackup(cur, 'przed-przywroceniem-' + Date.now(), 'Dane sprzed przywrócenia kopii').then(function () { return true; }, function () { return false; }));
        Promise.all(saves).then(function (ok) {
          if (!ok.some(Boolean)) { S.toast('Nie udało się zapisać kopii bezpieczeństwa — przywracanie przerwane', 'info'); return; }
          S.replaceState(next); // nie-ciche: zmiany trafią też do chmury
          renderBackups();
          S.showDone('Kopia przywrócona');
        });
      });
    }).catch(function (e) { S.toast('Nie udało się wczytać kopii: ' + errText(e), 'info'); });
  }

  // ---------- Instrukcja skrótu Apple Pay ----------
  function copyBox(text) {
    return '<div class="copy-box"><code>' + esc(text) + '</code><button class="copy-btn" data-copy="' + esc(text) + '">Kopiuj</button></div>';
  }
  function renderGuide() {
    var body = $('guideBody');
    if (!user) {
      body.innerHTML = '<p class="guide-intro">Najpierw zaloguj się w karcie Konto — płatności trafiają do Twojej bazy w chmurze.</p>';
      return;
    }
    if (!inboxKey) {
      body.innerHTML = '<p class="guide-intro">Przygotowuję Twój prywatny adres skrzynki…</p>';
      ensureInboxKey().then(function (k) {
        if (k) renderGuide();
        else body.innerHTML = '<p class="guide-intro">Nie udało się przygotować adresu (brak internetu?). Zamknij i otwórz instrukcję ponownie.</p>';
      });
      return;
    }
    var inbox = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/users/' + user.uid + '/in_' + inboxKey;
    body.innerHTML =
      '<p class="guide-intro">Raz ustawiasz automatyzację w aplikacji <b>Skróty</b> na iPhonie. Potem każda płatność Apple Pay (telefonem lub zegarkiem) sama dopisze się do Saldo jako wydatek z konta, z dobraną grupą. Skrót ma tylko 3 bloki i nie potrzebuje hasła.</p>' +
      '<div class="guide-step"><h4><span class="guide-num">1</span>Nowa automatyzacja</h4>' +
        '<p>Otwórz <b>Skróty → Automatyzacja → +</b> i wybierz <b>Portfel</b> (w starszych iOS: <b>Transakcja</b>). Zaznacz karty, wybierz <b>Uruchom od razu</b>, potem <b>Nowy pusty skrót</b>.</p></div>' +
      '<div class="guide-step"><h4><span class="guide-num">2</span>Adres skrzynki</h4>' +
        '<p>Dodaj czynność <b>URL</b> (ikona łańcucha) i wklej do niej ten adres — to Twój prywatny adres, nie pokazuj go nikomu:</p>' + copyBox(inbox) +
        '<p class="guide-note">Wklejanie: stuknij pole raz, potem drugi raz i wybierz <b>Wklej</b>. Nie przytrzymuj — to otwiera listę zmiennych.</p></div>' +
      '<div class="guide-step"><h4><span class="guide-num">3</span>Wysłanie płatności</h4>' +
        '<p>Dodaj czynność <b>Pobierz zawartość URL</b> (pod blokiem URL). Rozwiń szczegóły: <b>Metoda: POST</b>, <b>Treść żądania: JSON</b>. Nagłówków nie dodawaj.</p>' +
        '<p>Dodaj pole <b>Słownik</b> o kluczu</p>' + copyBox('fields') +
        '<p>Wejdź w nie i dodaj dwa pola typu <b>Słownik</b>:</p>' + copyBox('amount') + copyBox('merchant') +
        '<p>W każdym z nich dodaj pole <b>Tekst</b> o kluczu</p>' + copyBox('stringValue') +
        '<p>i jako wartość wstaw zmienną: przytrzymaj pole → <b>Dane wejściowe skrótu</b> → stuknij zmienną i wybierz:</p>' +
        '<ul><li>w amount → <b>Kwota</b></li><li>w merchant → <b>Sprzedawca</b></li></ul></div>' +
      '<div class="guide-step"><h4><span class="guide-num">4</span>Gotowe</h4>' +
        '<p>Zapisz automatyzację. Wydatek pojawi się w Saldo kilka sekund po płatności (albo przy następnym otwarciu aplikacji). Jeśli grupa się nie zgadza, zmień ją we wpisie — następnym razem Saldo zapamięta wybór dla tego sklepu.</p>' +
        '<p class="guide-note">Działa tylko z płatnościami Apple Pay. Ręczne uruchomienie skrótu (przycisk ▶) wysyła pustą kwotę — Saldo pokaże wtedy komunikat „Nie rozpoznano kwoty”, co znaczy, że połączenie działa.</p></div>' +
      '<button class="primary-btn primary-btn--plain" id="guideTest">Wyślij płatność testową (1,00 zł)</button>';
  }
  $('applePayGuide').addEventListener('click', function () { renderGuide(); $('guideBody').scrollTop = 0; S.openSheet($('guideSheet')); });
  $('guideClose').addEventListener('click', function () { S.closeSheet($('guideSheet')); });
  $('guideBody').addEventListener('click', function (e) {
    var c = e.target.closest('[data-copy]');
    if (c) {
      var txt = c.getAttribute('data-copy');
      var done = function () { c.textContent = 'Skopiowano'; setTimeout(function () { c.textContent = 'Kopiuj'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { S.toast('Nie udało się skopiować', 'info'); });
      return;
    }
    if (e.target.closest('#guideTest')) {
      if (!user || !ready) { S.toast('Najpierw zaloguj się i poczekaj na synchronizację', 'info'); return; }
      // Ta sama droga co skrót: dokument w skrzynce → aplikacja zamienia go w wydatek
      (inboxKey ? keyCol() : inboxCol()).add({ amount: '1,00 zł', merchant: 'Test Apple Pay' })
        .then(function () { S.closeSheet($('guideSheet')); })
        .catch(function (err) { S.toast('Nie udało się wysłać: ' + errText(err), 'info'); });
    }
  });

  // ---------- Zdarzenia ----------
  function authError(msg) { el.authError.textContent = msg; el.authError.hidden = !msg; }
  function creds() {
    var email = el.authEmail.value.trim(), pass = el.authPass.value;
    if (!email) { authError('Wpisz adres e-mail.'); el.authEmail.focus(); return null; }
    if (pass.length < 6) { authError('Hasło musi mieć co najmniej 6 znaków.'); el.authPass.focus(); return null; }
    authError('');
    return { email: email, pass: pass };
  }
  var busy = false;
  function run(p, ok) {
    busy = true; renderAccount();
    p.then(function () { el.authPass.value = ''; if (ok) S.showDone(ok); })
      .catch(function (e) { authError(errText(e)); })
      .then(function () { busy = false; el.authPass.setAttribute('autocomplete', 'current-password'); renderAccount(); });
  }
  el.authLogin.addEventListener('click', function () {
    if (busy || !auth) return;
    var c = creds(); if (!c) return;
    run(auth.signInWithEmailAndPassword(c.email, c.pass), 'Zalogowano');
  });
  el.authRegister.addEventListener('click', function () {
    if (busy || !auth) return;
    var c = creds(); if (!c) return;
    el.authPass.setAttribute('autocomplete', 'new-password');
    run(auth.createUserWithEmailAndPassword(c.email, c.pass), 'Konto utworzone');
  });
  el.authReset.addEventListener('click', function () {
    if (busy || !auth) return;
    var email = el.authEmail.value.trim();
    if (!email) { authError('Wpisz adres e-mail, a wyślę link do zmiany hasła.'); el.authEmail.focus(); return; }
    auth.languageCode = 'pl';
    run(auth.sendPasswordResetEmail(email).then(function () { authError(''); S.toast('Wysłano e-mail do zmiany hasła', 'success'); }));
  });
  el.authPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.authLogin.click(); } });
  el.authLogout.addEventListener('click', function () {
    S.confirmAction('Wylogować? Dane zostaną na tym urządzeniu, ale przestaną się synchronizować.', 'Wyloguj', function () {
      auth.signOut().then(function () { S.toast('Wylogowano', 'info'); });
    });
  });
  el.syncNow.addEventListener('click', function () {
    if (!user || reconciling) return;
    if (!ready) reconcile();
    else if (listenBroken) { listen(); setStatus('ok'); pushChanges(); }
    else cloudAutoBackup(true);
  });
  el.autoBackups.addEventListener('click', function (e) {
    var b = e.target.closest('[data-backup]');
    if (!b || !el.autoBackups._rows) return;
    restore(el.autoBackups._rows[Number(b.getAttribute('data-backup'))]);
  });

  window.addEventListener('saldo:changed', function () {
    localAutoBackup();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushChanges, 300);
  });
  window.addEventListener('saldo:tab', function (e) { if (e.detail === 'account') { renderAccount(); renderBackups(); } });
  window.addEventListener('online', function () {
    loadFirebase();
    if (!user) return;
    if (!ready) reconcile();
    else { if (listenBroken) listen(); setStatus(pending ? 'syncing' : 'ok'); pushChanges(); }
  });
  window.addEventListener('offline', function () { if (user) setStatus('offline'); });
  // Odświeżaj „Ostatnio: …” na karcie Konto
  setInterval(function () { if (!$('viewAccount').hidden) renderAccount(); }, 30000);

  renderAccount();
  renderBackups();
  localAutoBackup();
  loadFirebase();
})();
