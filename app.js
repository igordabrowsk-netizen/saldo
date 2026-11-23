/* Saldo — kontrola środków (gotówka, konto, pożyczone, grupy wydatków, statystyki).
   Dane w localStorage (klucz saldo_v1), kwoty w groszach (liczby całkowite). */
(function () {
  'use strict';

  var icon = SaldoIcons.icon;
  var DEFAULT_CATS = SaldoIcons.DEFAULT_CATS;
  var CUSTOM_COLORS = SaldoIcons.CUSTOM_COLORS;
  var REDUCED = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function paintIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      el.innerHTML = icon(el.getAttribute('data-icon'));
    });
  }

  // ---------- Dane ----------
  var KEY = 'saldo_v1';
  var SOURCES = {
    cash: { name: 'Gotówka', short: 'Gotówka', icon: 'banknote' },
    bank: { name: 'Konto bankowe', short: 'Konto', icon: 'landmark' }
  };
  var HISTORY_LIMIT = 5000;
  var MAX_GROSZE = 99999999999; // 999 999 999,99 zł
  var loadWarning = '';

  function defaultState() {
    return { cash: 0, bank: 0, cashAt: null, bankAt: null, loans: [], loansAt: null, lastFund: 'cash', history: [], customCats: [] };
  }
  function num(v) { v = Number(v); return isFinite(v) ? Math.round(v) : 0; }

  // Uzupełnia brakujące pola starszych wersji danych
  function migrate(s) {
    var d = defaultState();
    for (var k in d) if (!(k in s) || s[k] === undefined) s[k] = d[k];
    delete s.privacy;
    s.cash = num(s.cash); s.bank = num(s.bank);
    if (!Array.isArray(s.history)) s.history = [];
    if (!Array.isArray(s.loans)) s.loans = [];
    if (!Array.isArray(s.customCats)) s.customCats = [];
    var seen = {};
    s.history = s.history.filter(function (e) { return e && typeof e === 'object' && (e.source === 'cash' || e.source === 'bank' || e.source === 'loan'); });
    s.history.forEach(function (e, i) {
      if (!e.id || seen[e.id]) e.id = 'm' + i.toString(36) + '_' + (num(e.at) || 0).toString(36);
      seen[e.id] = 1;
      e.before = num(e.before); e.after = num(e.after); e.at = num(e.at) || Date.now();
      if (e.note == null) e.note = '';
      if (e.mode === 'move') { e.amount = num(e.amount) || Math.abs(e.after - e.before); if (e.to !== 'cash' && e.to !== 'bank') e.to = e.source === 'cash' ? 'bank' : 'cash'; }
      if (e.source === 'loan' && !e.name) e.name = 'Bez nazwy';
    });
    s.history.sort(function (a, b) { return b.at - a.at; });
    s.loans = s.loans.filter(function (l) { return l && typeof l === 'object' && l.name; });
    s.loans.forEach(function (l, i) {
      if (!l.id) l.id = 'l' + i + '_' + Date.now().toString(36);
      l.name = String(l.name);
      l.amount = num(l.amount);
      l.since = num(l.since) || num(l.at) || Date.now();
      if (l.at !== undefined) l.at = num(l.at) || l.since;
      if (l.funds && typeof l.funds !== 'object') delete l.funds;
    });
    s.history.forEach(function (e) { if (e.loanSince !== undefined) e.loanSince = num(e.loanSince) || null; if (e.name !== undefined) e.name = String(e.name); });
    ['cashAt', 'bankAt', 'loansAt'].forEach(function (k) { s[k] = num(s[k]) || null; });
    s.customCats = s.customCats.filter(function (c) { return c && typeof c === 'object' && c.id && c.name; });
    s.customCats.forEach(function (c) { c.name = String(c.name).slice(0, 24); if (!/^#[0-9a-f]{6}$/i.test(c.color || '')) c.color = '#8e8e93'; if (!c.icon) c.icon = 'tag'; });
    if (['cash', 'bank', 'none'].indexOf(s.lastFund) === -1) s.lastFund = 'cash';
    return s;
  }
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return defaultState(); }
    if (!raw) return defaultState();
    try {
      return migrate(JSON.parse(raw));
    } catch (e) {
      // Uszkodzone dane — zachowaj kopię zamiast nadpisywać
      try { localStorage.setItem(KEY + '_uszkodzone_' + Date.now(), raw); } catch (e2) { /* brak miejsca */ }
      loadWarning = 'Nie udało się odczytać danych. Zachowano ich kopię.';
      return defaultState();
    }
  }
  var dirty = false; // zmiany, których nie udało się zapisać
  var syncActive = false; // włączona synchronizacja z chmurą (sync.js)
  // opts.silent — zapis bez powiadamiania bazy w chmurze (np. gdy dane właśnie przyszły z chmury)
  function save(opts) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      dirty = false;
      if (!(opts && opts.silent)) {
        try { window.dispatchEvent(new CustomEvent('saldo:changed')); } catch (e) { /* stara przeglądarka */ }
      }
      return true;
    } catch (e) {
      dirty = true;
      toast('Nie udało się zapisać danych na urządzeniu', 'info');
      return false;
    }
  }
  var state = load();

  function loansTotal() { return state.loans.reduce(function (s, l) { return s + l.amount; }, 0); }
  function findLoan(id) { for (var i = 0; i < state.loans.length; i++) if (state.loans[i].id === id) return state.loans[i]; return null; }
  function findEntry(id) { for (var i = 0; i < state.history.length; i++) if (state.history[i].id === id) return state.history[i]; return null; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function other(key) { return key === 'cash' ? 'bank' : 'cash'; }
  function sameName(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
  function findLoanByName(name) { return state.loans.filter(function (l) { return sameName(l.name, name); })[0] || null; }

  // ---------- Udziały pożyczki: ile wyszło z gotówki, z konta, a ile zapisano „bez zmian” ----------
  var FUND_KEYS = ['cash', 'bank', 'none'];
  function emptyFunds() { return { cash: 0, bank: 0, none: 0 }; }
  function fundKey(f) { return f === 'cash' || f === 'bank' ? f : 'none'; }
  // Zdejmuje kwotę v z udziałów w podanej kolejności; zwraca zmiany (ujemne)
  function reduceShares(f, v, order) {
    var ch = emptyFunds();
    order.forEach(function (k) {
      if (v <= 0) return;
      var t = Math.min(f[k], v);
      f[k] -= t; ch[k] -= t; v -= t;
    });
    return ch;
  }
  function normFunds(f, amount) {
    FUND_KEYS.forEach(function (k) { f[k] = Math.max(0, num(f[k])); });
    var sum = f.cash + f.bank + f.none;
    if (sum < amount) f.none += amount - sum;
    else if (sum > amount) reduceShares(f, sum - amount, ['none', 'bank', 'cash']);
    return f;
  }
  function repayOrder(k) { return k === 'none' ? ['none', 'cash', 'bank'] : [k, 'none', other(k)]; }
  // Odtwarza udziały starszych pożyczek z historii (od najstarszego wpisu)
  function replayFunds(name, beforeTs) {
    var f = emptyFunds();
    state.history.filter(function (e) { return e.source === 'loan' && sameName(e.name, name) && (beforeTs === undefined || e.at < beforeTs); })
      .slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (e) {
      if (e.mode === 'del' || e.after === 0) { f = emptyFunds(); return; }
      var d = e.after - e.before, k = fundKey(e.fund);
      if (d > 0) f[e.mode === 'set' ? 'none' : k] += d;
      else if (d < 0) reduceShares(f, -d, e.mode === 'sub' ? repayOrder(k) : ['none', 'cash', 'bank']);
    });
    return f;
  }
  function fundsOf(l) {
    if (!l.funds) {
      var f = replayFunds(l.name);
      if (f.cash + f.bank + f.none === 0 && (l.fund === 'cash' || l.fund === 'bank')) f[l.fund] = l.amount;
      l.funds = f;
    }
    return normFunds(l.funds, l.amount);
  }
  function fundsLabel(f) {
    if (f.cash && f.bank) return 'z gotówki i konta';
    if (f.cash) return 'z gotówki';
    if (f.bank) return 'z konta';
    return '';
  }

  // ---------- Grupy wydatków ----------
  function norm(s) {
    return String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }
  function allCats() { return DEFAULT_CATS.concat(state.customCats); }
  function catById(id) {
    var list = allCats();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return DEFAULT_CATS[DEFAULT_CATS.length - 1]; // Inne
  }
  function catUsage() {
    var u = {};
    state.history.forEach(function (e) { if (e.mode === 'sub' && e.source !== 'loan') u[e.cat || 'other'] = (u[e.cat || 'other'] || 0) + 1; });
    return u;
  }
  function nextCustomColor() {
    var used = state.customCats.map(function (c) { return c.color; });
    for (var i = 0; i < CUSTOM_COLORS.length; i++) if (used.indexOf(CUSTOM_COLORS[i]) === -1) return CUSTOM_COLORS[i];
    return CUSTOM_COLORS[state.customCats.length % CUSTOM_COLORS.length];
  }
  // Zwraca { cat, created }
  function addCustomCat(name) {
    name = String(name).trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!name) return null;
    var exists = allCats().filter(function (c) { return norm(c.name) === norm(name); })[0];
    if (exists) return { cat: exists, created: false };
    var c = { id: 'c_' + uid(), name: name, icon: 'tag', color: nextCustomColor() };
    state.customCats.push(c);
    save();
    return { cat: c, created: true };
  }

  // Wiersz „Grupa wydatku” (w arkuszu kwoty i w szczegółach wpisu)
  function renderCatButton(prefix, id) {
    var iconEl = document.getElementById(prefix + 'Icon');
    var nameEl = document.getElementById(prefix + 'Name');
    if (!id) {
      iconEl.style.backgroundColor = 'var(--gray)';
      iconEl.innerHTML = icon('tag');
      nameEl.textContent = 'Wybierz grupę';
      nameEl.classList.add('is-placeholder');
      return;
    }
    var c = catById(id);
    iconEl.style.backgroundColor = c.color;
    iconEl.innerHTML = icon(c.icon);
    nameEl.textContent = c.name;
    nameEl.classList.remove('is-placeholder');
  }

  // Arkusz wyboru grupy z wyszukiwarką
  var catPick = null; // { selected, onPick }
  function byName(a, b) {
    if (a.id === 'other') return 1;
    if (b.id === 'other') return -1;
    return a.name.localeCompare(b.name, 'pl');
  }
  function catRow(c, sel) {
    return '<li><button class="row cat-row" data-pick="' + esc(c.id) + '">' +
      '<span class="row-icon cat-icon" style="background-color:' + c.color + '">' + icon(c.icon) + '</span>' +
      '<span class="row-body"><span class="row-title">' + esc(c.name) + '</span></span>' +
      (c.id === sel ? '<span class="row-check ic">' + icon('check') + '</span>' : '') +
      '</button></li>';
  }
  function catMatches(q) {
    var nq = norm(q);
    return allCats().filter(function (c) { return norm(c.name).indexOf(nq) !== -1; }).sort(function (a, b) {
      var as = norm(a.name).indexOf(nq) === 0, bs = norm(b.name).indexOf(nq) === 0;
      return as !== bs ? (as ? -1 : 1) : byName(a, b);
    });
  }
  function renderCatResults() {
    var q = el.catSearch.value.trim();
    var sel = catPick ? catPick.selected : null;
    var html = '';
    if (!q) {
      var u = catUsage();
      var top = allCats().filter(function (c) { return u[c.id]; }).sort(function (a, b) { return u[b.id] - u[a.id]; }).slice(0, 5);
      if (top.length) html += '<h2 class="section-header">Najczęściej używane</h2><ul class="group">' + top.map(function (c) { return catRow(c, sel); }).join('') + '</ul>';
      html += '<h2 class="section-header">Wszystkie grupy</h2><ul class="group">' +
        allCats().slice().sort(byName).map(function (c) { return catRow(c, sel); }).join('') + '</ul>';
    } else {
      var hits = catMatches(q);
      var exact = allCats().some(function (c) { return norm(c.name) === norm(q); });
      html += '<ul class="group">' + hits.map(function (c) { return catRow(c, sel); }).join('');
      if (!exact) {
        html += '<li><button class="row cat-row" data-create><span class="row-icon row-icon--blue">' + icon('plus') + '</span>' +
          '<span class="row-body"><span class="row-title">Dodaj grupę „' + esc(q.slice(0, 24)) + '”</span><span class="row-sub">Nowa własna grupa</span></span></button></li>';
      }
      html += '</ul>';
    }
    el.catResults.innerHTML = html;
  }
  function openCatPicker(selected, onPick) {
    catPick = { selected: selected, onPick: onPick };
    el.catSearch.value = '';
    renderCatResults();
    el.catResults.scrollTop = 0;
    openPanel(el.catSheet);
    el.catSearch.focus({ preventScroll: true });
  }
  function pickCat(id) {
    if (!isOpen(el.catSheet)) return;
    if (catPick) catPick.onPick(id);
    closePanel(el.catSheet);
  }
  function createCatFromSearch() {
    var r = addCustomCat(el.catSearch.value);
    if (!r) return;
    pickCat(r.cat.id);
    renderStatsIfVisible();
    if (r.created) showDone('Dodano grupę: ' + r.cat.name);
  }

  // ---------- Formatowanie ----------
  var fmt = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  function group3(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function money(grosze) {
    var neg = grosze < 0;
    var parts = fmt.format(Math.abs(grosze) / 100).split(',');
    return (neg ? '−' : '') + group3(parts[0]) + ',' + parts[1] + ' zł';
  }
  function signed(grosze) { return (grosze > 0 ? '+' : '') + money(grosze); }
  function moneyShort(grosze) {
    var zl = Math.round(Math.abs(grosze) / 100);
    return (grosze < 0 ? '−' : grosze > 0 ? '+' : '') + group3(String(zl)) + ' zł';
  }
  function parseAmount(str) {
    if (str == null) return NaN;
    var s = String(str).replace(/\s| /g, '').replace(/zł/gi, '').replace(',', '.');
    if (s === '' || s === '.') return NaN;
    if (!/^\d*\.?\d{0,2}$/.test(s)) return NaN;
    var n = Math.round(parseFloat(s) * 100);
    return isFinite(n) && n <= MAX_GROSZE ? n : NaN;
  }
  function plural(n, one, few, many) {
    if (n === 1) return '1 ' + one;
    var d = n % 10, h = n % 100;
    return n + ' ' + (d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many);
  }
  function initials(name) {
    var w = String(name).trim().split(/\s+/);
    return ((w[0] || '').charAt(0) + (w[1] || '').charAt(0)).toUpperCase() || '?';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var dayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  var timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });
  var dateFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short' });
  var fullFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  var dayLongFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' });
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  function when(ts) {
    if (!ts) return 'Brak danych';
    var d = new Date(ts);
    var diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (Date.now() - ts < 60000) return 'Przed chwilą';
    if (diff === 0) return 'Dziś, ' + timeFmt.format(d);
    if (diff === 1) return 'Wczoraj, ' + timeFmt.format(d);
    return dateFmt.format(d) + ', ' + timeFmt.format(d);
  }

  var MONTHS = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
  var MONTHS_IN = ['styczniu', 'lutym', 'marcu', 'kwietniu', 'maju', 'czerwcu', 'lipcu', 'sierpniu', 'wrześniu', 'październiku', 'listopadzie', 'grudniu'];
  var MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
  function monthIdx(ts) { var d = new Date(ts); return d.getFullYear() * 12 + d.getMonth(); }
  function idxYear(i) { return Math.floor(i / 12); }
  function idxMonth(i) { return i % 12; }

  // ---------- Elementy ----------
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    today: $('today'), navbar: $('navbar'), navbarTitle: $('navbarTitle'),
    viewHome: $('viewHome'), viewStats: $('viewStats'), tabbar: $('tabbar'),
    totalAmount: $('totalAmount'), totalUpdated: $('totalUpdated'),
    splitCash: $('splitCash'), splitBank: $('splitBank'), splitLoan: $('splitLoan'),
    pctCash: $('pctCash'), pctBank: $('pctBank'), pctLoan: $('pctLoan'), legendLoan: $('legendLoan'),
    cashAmount: $('cashAmount'), bankAmount: $('bankAmount'), loansAmount: $('loansAmount'),
    cashUpdated: $('cashUpdated'), bankUpdated: $('bankUpdated'), loansSub: $('loansSub'), loansRow: $('loansRow'),
    history: $('history'), historyEmpty: $('historyEmpty'), historyHint: $('historyHint'),
    historySheet: $('historySheet'), histClose: $('histClose'), histPeriodBtn: $('histPeriodBtn'), histPeriodName: $('histPeriodName'),
    histCustom: $('histCustom'), histFrom: $('histFrom'), histTo: $('histTo'), histType: $('histType'),
    histSummary: $('histSummary'), histList: $('histList'), histEmpty: $('histEmpty'),
    backdrop: $('backdrop'),
    sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetCancel: $('sheetCancel'), sheetSave: $('sheetSave'),
    modeControl: $('modeControl'), nameGroup: $('nameGroup'), nameInput: $('nameInput'),
    sheetCurrentLabel: $('sheetCurrentLabel'), sheetCurrent: $('sheetCurrent'),
    amountField: document.querySelector('.amount-field'), amountInput: $('amountInput'), amountSign: $('amountSign'),
    sheetPreview: $('sheetPreview'), previewValue: $('previewValue'),
    catBlock: $('catBlock'), catPickBtn: $('catPickBtn'), moveHint: $('moveHint'),
    catSheet: $('catSheet'), catSearch: $('catSearch'), catResults: $('catResults'), catCancel: $('catCancel'),
    fundBlock: $('fundBlock'), fundLabel: $('fundLabel'), fundControl: $('fundControl'), fundHint: $('fundHint'),
    noteInput: $('noteInput'), sheetError: $('sheetError'), fillAllBtn: $('fillAllBtn'),
    personSheet: $('personSheet'), personBack: $('personBack'), personTitle: $('personTitle'), personAvatar: $('personAvatar'),
    personAmount: $('personAmount'), personMeta: $('personMeta'), personRepay: $('personRepay'), personLend: $('personLend'),
    personHistory: $('personHistory'), personCorrect: $('personCorrect'), personDelete: $('personDelete'),
    loansSheet: $('loansSheet'), loansClose: $('loansClose'), loansAdd: $('loansAdd'), loansAddBig: $('loansAddBig'),
    loansTotal: $('loansTotal'), loanList: $('loanList'), loansEmpty: $('loansEmpty'),
    entrySheet: $('entrySheet'), entryCancel: $('entryCancel'), entrySave: $('entrySave'),
    entryIcon: $('entryIcon'), entryAmount: $('entryAmount'), entryMeta: $('entryMeta'),
    entryCatBlock: $('entryCatBlock'), entryCatPickBtn: $('entryCatPickBtn'), entryNote: $('entryNote'),
    entryDelete: $('entryDelete'), entryDeleteHint: $('entryDeleteHint'),
    monthPrev: $('monthPrev'), monthNext: $('monthNext'), monthLabel: $('monthLabel'),
    savingsLabel: $('savingsLabel'), savingsAmount: $('savingsAmount'), savingsRate: $('savingsRate'),
    incomeAmount: $('incomeAmount'), expenseAmount: $('expenseAmount'),
    savingsChart: $('savingsChart'), savingsCaption: $('savingsCaption'),
    catStats: $('catStats'), catStatsEmpty: $('catStatsEmpty'),
    dailyChart: $('dailyChart'), dailyReadout: $('dailyReadout'),
    customCats: $('customCats'), customCatsHint: $('customCatsHint'), addCatBtn: $('addCatBtn'),
    backupExport: $('backupExport'), backupImport: $('backupImport'), backupFile: $('backupFile'),
    actionSheet: $('actionSheet'), actionTitle: $('actionTitle'), actionGroup: $('actionGroup'), actionCancel: $('actionCancel'),
    toast: $('toast'), toastIcon: $('toastIcon'), toastText: $('toastText'),
    doneHud: $('doneHud'), doneText: $('doneText')
  };

  // ---------- Animacja liczb ----------
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function animateMoney(node, to, signedFmt) {
    var f = signedFmt ? signed : money;
    var from = node.dataset.v === undefined ? null : Number(node.dataset.v);
    node.dataset.v = to;
    if (node._raf) cancelAnimationFrame(node._raf);
    if (from === null || from === to || REDUCED.matches || document.hidden) { node.textContent = f(to); return; }
    var start = null, dur = 420;
    var step = function (ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      node.textContent = f(Math.round(from + (to - from) * easeOut(t)));
      if (t < 1) node._raf = requestAnimationFrame(step);
      else {
        node._raf = null;
        node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
      }
    };
    node._raf = requestAnimationFrame(step);
  }

  // ---------- Render: Środki ----------
  var lastNewId = null;

  function render() {
    renderHome();
    renderStatsIfVisible();
  }

  function renderHome() {
    var lt = loansTotal();
    var total = state.cash + state.bank + lt;
    el.today.textContent = dayFmt.format(new Date());

    animateMoney(el.totalAmount, total);
    el.totalAmount.classList.toggle('is-long', Math.abs(total) >= 10000000);
    var last = Math.max(state.cashAt || 0, state.bankAt || 0, state.loansAt || 0);
    el.totalUpdated.textContent = last ? when(last) : '';

    var c = Math.max(state.cash, 0), b = Math.max(state.bank, 0), l = Math.max(lt, 0);
    var pos = c + b + l;
    var pc = pos ? Math.round(c / pos * 100) : 0;
    var pl = pos ? Math.round(l / pos * 100) : 0;
    var pb = pos ? 100 - pc - pl : 0;
    [[el.splitCash, pc], [el.splitBank, pb], [el.splitLoan, pl]].forEach(function (x) {
      x[0].style.width = x[1] + '%';
      x[0].style.display = x[1] ? '' : 'none';
    });
    el.pctCash.textContent = pc + '%';
    el.pctBank.textContent = pb + '%';
    el.pctLoan.textContent = pl + '%';
    el.legendLoan.hidden = state.loans.length === 0;

    animateMoney(el.cashAmount, state.cash);
    animateMoney(el.bankAmount, state.bank);
    animateMoney(el.loansAmount, lt);
    el.cashAmount.classList.toggle('is-neg', state.cash < 0);
    el.bankAmount.classList.toggle('is-neg', state.bank < 0);
    el.cashUpdated.textContent = state.cashAt ? when(state.cashAt) : 'Stuknij, aby ustawić';
    el.bankUpdated.textContent = state.bankAt ? when(state.bankAt) : 'Stuknij, aby ustawić';
    el.loansSub.textContent = state.loans.length ? plural(state.loans.length, 'osoba', 'osoby', 'osób') : 'Stuknij, aby dodać';

    renderHistory();
    renderLoans();
    renderPerson();
    refreshEntry();
  }

  function renderLoans() {
    el.loansTotal.textContent = money(loansTotal());
    el.loansEmpty.hidden = state.loans.length > 0;
    var sorted = state.loans.slice().sort(function (a, b) { return b.amount - a.amount; });
    el.loanList.innerHTML = sorted.map(function (l) {
      var src = fundsLabel(fundsOf(l));
      return '<li><button class="row" data-loan="' + esc(l.id) + '">' +
        '<span class="avatar">' + esc(initials(l.name)) + '</span>' +
        '<span class="row-body"><span class="row-title">' + esc(l.name) + '</span>' +
        '<span class="row-sub">Od ' + esc(dateFmt.format(new Date(l.since))) + (src ? ' · ' + src : '') + (l.note ? ' · ' + esc(l.note) : '') + '</span></span>' +
        '<span class="row-value amount">' + money(l.amount) + '</span>' +
        '<span class="row-chevron ic">' + icon('chevronRight') + '</span>' +
        '</button></li>';
    }).join('');
  }

  var FUND_FROM = { cash: ' z gotówki', bank: ' z konta', none: '' };
  var FUND_TO = { cash: ' do gotówki', bank: ' na konto', none: '' };

  function returnedLabel(r) {
    var parts = [];
    if (r && r.cash) parts.push(money(r.cash) + ' do gotówki');
    if (r && r.bank) parts.push(money(r.bank) + ' na konto');
    return parts.join(' i ');
  }

  // Wygląd wpisu historii: ikona, kolor, tytuł, opis, kwota
  function describe(e) {
    var d = { delta: e.after - e.before, bg: '', cls: 'row-icon--gray', ic: 'equal', title: '', sub: '', deltaCls: 'neu' };
    if (e.source === 'loan') {
      var f = e.fund || 'none';
      if (e.mode === 'add') { d.ic = 'handCoins'; d.cls = 'row-icon--orange'; d.sub = 'Pożyczka' + FUND_FROM[fundKey(f)]; }
      else if (e.mode === 'sub') { d.ic = 'undo'; d.cls = 'row-icon--green'; d.sub = (e.after === 0 ? 'Spłata całości' : 'Spłata') + FUND_TO[fundKey(f)]; }
      else if (e.mode === 'del') {
        d.ic = 'trash'; d.cls = 'row-icon--gray';
        if (e.returned && (e.returned.cash || e.returned.bank)) d.sub = 'Cofnięto pożyczkę';
        else if (!e.returned && fundKey(f) !== 'none') d.sub = 'Cofnięto pożyczkę, zwrot' + FUND_TO[fundKey(f)];
        else d.sub = e.writeOff ? 'Spisano na straty' : 'Usunięto pożyczkę';
      }
      else { d.ic = 'equal'; d.cls = 'row-icon--indigo'; d.sub = 'Korekta pożyczki'; }
      d.title = e.note ? e.name + ': ' + e.note : e.name;
      d.deltaCls = 'loan';
      return d;
    }
    var src = SOURCES[e.source].short;
    if (e.mode === 'sub') {
      var c = catById(e.cat || 'other');
      d.ic = c.icon; d.cls = 'cat-icon'; d.bg = c.color;
      d.title = e.note || c.name;
      d.sub = (e.note ? c.name + ' · ' : '') + (e.via === 'applepay' ? 'Apple Pay' : src);
      d.deltaCls = 'neg';
    } else if (e.mode === 'add') {
      d.ic = 'plus'; d.cls = 'row-icon--green';
      d.title = e.note || 'Wpływ'; d.sub = src; d.deltaCls = 'pos';
    } else if (e.mode === 'move') {
      d.ic = 'arrowLeftRight'; d.cls = 'row-icon--blue';
      d.title = e.note || (e.to === 'bank' ? 'Wpłata na konto' : 'Wypłata do gotówki');
      d.sub = SOURCES[e.source].short + ' → ' + SOURCES[e.to].short;
      d.delta = e.amount; d.deltaCls = 'move';
    } else {
      d.ic = 'equal'; d.cls = 'row-icon--indigo';
      d.title = e.note || 'Korekta stanu'; d.sub = src;
      d.deltaCls = d.delta > 0 ? 'pos' : d.delta < 0 ? 'neg' : 'neu';
    }
    return d;
  }
  function iconBadge(d) {
    return '<span class="row-icon ' + d.cls + '"' + (d.bg ? ' style="background-color:' + d.bg + '"' : '') + '>' + icon(d.ic) + '</span>';
  }

  // Jeden wiersz historii; timeOnly = w widoku dni pokazuj samą godzinę
  function histRow(e, timeOnly) {
    var d = describe(e);
    var deltaTxt = e.mode === 'move' ? money(d.delta) : signed(d.delta);
    var t = timeOnly ? timeFmt.format(new Date(e.at)) : when(e.at);
    return '<li><button class="row hist-row' + (e.id === lastNewId ? ' is-new' : '') + '" data-entry="' + esc(e.id) + '">' + iconBadge(d) +
      '<span class="row-body"><span class="row-title">' + esc(d.title) + '</span><span class="row-sub">' + esc(d.sub + ' · ' + t) + '</span></span>' +
      '<span class="hist-right"><span class="hist-delta amount ' + d.deltaCls + '">' + deltaTxt + '</span>' +
      '<span class="hist-after amount">' + money(e.after) + '</span></span></button></li>';
  }

  var HOME_HISTORY = 5;
  function renderHistory() {
    var h = state.history;
    el.historyEmpty.hidden = h.length > 0;
    el.history.hidden = h.length === 0;
    el.historyHint.hidden = h.length === 0;
    var items = h.slice(0, HOME_HISTORY).map(function (e) { return histRow(e, false); });
    if (h.length) {
      items.push('<li><button class="row hist-all" id="histAll"><span class="row-body"><span class="row-title">Pokaż całą historię</span></span>' +
        '<span class="hist-all-count">' + h.length + '</span><span class="row-chevron ic">' + icon('chevronRight') + '</span></button></li>');
    }
    el.history.innerHTML = items.join('');
    renderHistorySheet();
  }

  // ---------- Ekran całej historii z filtrami ----------
  var HIST_PERIODS = [
    { id: 'today', name: 'Dziś' },
    { id: '7d', name: 'Ostatnie 7 dni' },
    { id: '30d', name: 'Ostatnie 30 dni' },
    { id: 'month', name: 'Ten miesiąc' },
    { id: 'prev', name: 'Poprzedni miesiąc' },
    { id: '3m', name: 'Ostatnie 3 miesiące' },
    { id: 'year', name: 'Ten rok' },
    { id: 'all', name: 'Wszystko' },
    { id: 'custom', name: 'Własny zakres' }
  ];
  var histFilter = { period: 'month', type: 'all', from: '', to: '' };
  var histLimit = 100;

  function ymd(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function parseYmd(s) { var a = String(s).split('-').map(Number); return a.length === 3 && a[0] ? new Date(a[0], a[1] - 1, a[2]) : null; }

  function periodRange() {
    var n = new Date(), y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
    var INF = Infinity;
    switch (histFilter.period) {
      case 'today': return [new Date(y, m, d).getTime(), INF];
      case '7d': return [new Date(y, m, d - 6).getTime(), INF];
      case '30d': return [new Date(y, m, d - 29).getTime(), INF];
      case 'month': return [new Date(y, m, 1).getTime(), INF];
      case 'prev': return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
      case '3m': return [new Date(y, m - 2, 1).getTime(), INF];
      case 'year': return [new Date(y, 0, 1).getTime(), INF];
      case 'custom':
        var f = parseYmd(histFilter.from), t = parseYmd(histFilter.to);
        if (f && t && f > t) { var tmp = f; f = t; t = tmp; } // odwrócone daty
        return [f ? f.getTime() : 0, t ? new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() : INF];
      default: return [0, INF];
    }
  }
  function matchesType(e) {
    var t = histFilter.type;
    if (t === 'all') return true;
    if (t === 'loan') return e.source === 'loan';
    if (e.source === 'loan') return false;
    return t === 'exp' ? e.mode === 'sub' : e.mode === 'add';
  }
  function dayLabel(ts) {
    var diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (diff === 0) return 'Dziś';
    if (diff === 1) return 'Wczoraj';
    var d = new Date(ts);
    var opts = { weekday: 'long', day: 'numeric', month: 'long' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    var s = new Intl.DateTimeFormat('pl-PL', opts).format(d);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function isExpense(e) { return e.source !== 'loan' && e.mode === 'sub'; }

  function renderHistorySheet() {
    if (!isOpen(el.historySheet)) return;
    var p = HIST_PERIODS.filter(function (x) { return x.id === histFilter.period; })[0];
    el.histPeriodName.textContent = p.name;
    el.histCustom.hidden = histFilter.period !== 'custom';
    setSegment(el.histType, 'data-htype', histFilter.type);

    var r = periodRange();
    var list = state.history.filter(function (e) { return e.at >= r[0] && e.at < r[1] && matchesType(e); });
    var exp = 0, inc = 0, daySum = {};
    list.forEach(function (e) {
      if (e.source === 'loan') return;
      if (e.mode === 'sub') {
        exp += e.before - e.after;
        var k = startOfDay(e.at);
        daySum[k] = (daySum[k] || 0) + e.before - e.after;
      }
      if (e.mode === 'add') inc += e.after - e.before;
    });
    var parts = [plural(list.length, 'wpis', 'wpisy', 'wpisów')];
    if (inc) parts.push('wpływy <b>' + money(inc) + '</b>');
    if (exp) parts.push('wydatki <b>' + money(exp) + '</b>');
    el.histSummary.innerHTML = parts.join(' · ');

    var html = '', curDay = null, dayItems = [];
    var flush = function () {
      if (curDay === null) return;
      html += '<div class="day-header"><span>' + esc(dayLabel(curDay)) + '</span>' + (daySum[curDay] ? '<span class="amount">' + money(-daySum[curDay]) + '</span>' : '') + '</div>' +
        '<ul class="group">' + dayItems.join('') + '</ul>';
    };
    for (var i = 0; i < list.length && i < histLimit; i++) {
      var e = list[i];
      var k = startOfDay(e.at);
      if (k !== curDay) { flush(); curDay = k; dayItems = []; }
      dayItems.push(histRow(e, true));
    }
    flush();
    if (list.length > histLimit) html += '<button class="primary-btn primary-btn--plain" id="histMoreBtn">Pokaż więcej (' + (list.length - histLimit) + ')</button>';
    el.histList.innerHTML = html;
    el.histEmpty.hidden = list.length > 0;
  }

  function openHistory() {
    histLimit = 100;
    openPanel(el.historySheet);
    renderHistorySheet();
    el.historySheet.querySelector('.sheet-scroll').scrollTop = 0;
  }

  function choosePeriod() {
    actionChoices('Pokaż wpisy z okresu', HIST_PERIODS.map(function (p) {
      return {
        text: p.name, bold: p.id === histFilter.period,
        cb: function () {
          histFilter.period = p.id;
          if (p.id === 'custom') {
            var n = new Date();
            if (!histFilter.from) histFilter.from = ymd(new Date(n.getFullYear(), n.getMonth(), 1));
            if (!histFilter.to) histFilter.to = ymd(n);
            el.histFrom.value = histFilter.from;
            el.histTo.value = histFilter.to;
          }
          histLimit = 100;
          renderHistorySheet();
        }
      };
    }));
  }

  // ---------- Statystyki ----------
  var nowIdx = monthIdx(Date.now());
  var selMonth = nowIdx;
  var selDay = null;

  function syncNow() {
    var n = monthIdx(Date.now());
    if (n !== nowIdx) {
      if (selMonth === nowIdx) { selMonth = n; selDay = null; } // użytkownik patrzył na bieżący miesiąc
      nowIdx = n;
    }
    if (selMonth > nowIdx) selMonth = nowIdx;
  }

  function computeMonths() {
    var m = {};
    state.history.forEach(function (e) {
      if (e.source === 'loan' || (e.mode !== 'add' && e.mode !== 'sub')) return;
      var i = monthIdx(e.at);
      var x = m[i] || (m[i] = emptyMonth());
      x.n++;
      if (e.mode === 'add') { x.inc += e.after - e.before; return; }
      var v = e.before - e.after;
      var c = catById(e.cat || 'other').id;
      x.exp += v;
      x.byCat[c] = (x.byCat[c] || 0) + v;
      x.catCount[c] = (x.catCount[c] || 0) + 1;
      var day = new Date(e.at).getDate();
      x.days[day] = (x.days[day] || 0) + v;
      x.dayCount[day] = (x.dayCount[day] || 0) + 1;
    });
    return m;
  }
  function emptyMonth() { return { inc: 0, exp: 0, byCat: {}, catCount: {}, days: {}, dayCount: {}, n: 0 }; }

  function renderStatsIfVisible() { if (!el.viewStats.hidden) renderStats(); }

  var lastChartKey = '';
  function renderStats() {
    syncNow();
    var months = computeMonths();
    var keys = Object.keys(months).map(Number);
    var firstIdx = keys.length ? Math.min.apply(null, keys) : nowIdx;
    var cur = months[selMonth] || emptyMonth();
    var mi = idxMonth(selMonth);
    // Słupki animujemy tylko przy zmianie miesiąca lub danych, nie przy każdym odświeżeniu
    var chartKey = selMonth + ':' + state.history.length + ':' + (state.history[0] ? state.history[0].id : '');
    var animate = chartKey !== lastChartKey;
    lastChartKey = chartKey;

    el.monthLabel.textContent = MONTHS[mi] + ' ' + idxYear(selMonth);
    el.monthPrev.disabled = selMonth <= Math.min(firstIdx, nowIdx - 1);
    el.monthNext.disabled = selMonth >= nowIdx;

    var s = cur.inc - cur.exp;
    el.savingsLabel.textContent = (s < 0 ? 'Na minusie w ' : 'Odłożone w ') + MONTHS_IN[mi];
    animateMoney(el.savingsAmount, s, true);
    el.savingsAmount.classList.toggle('is-neg', s < 0);
    if (!cur.n) el.savingsRate.innerHTML = 'Brak wpływów i wydatków w tym miesiącu.';
    else if (s >= 0 && cur.inc > 0) el.savingsRate.innerHTML = 'To <b>' + Math.round(s / cur.inc * 100) + '%</b> wpływów z tego miesiąca.';
    else if (s < 0) el.savingsRate.innerHTML = 'Wydatki były wyższe od wpływów o <b>' + money(-s) + '</b>.';
    else el.savingsRate.innerHTML = 'Brak wpływów w tym miesiącu.';
    el.incomeAmount.textContent = money(cur.inc);
    el.expenseAmount.textContent = money(cur.exp);

    renderSavingsChart(months, animate);
    renderCatStats(cur, animate);
    renderDailyChart(cur, animate);
    renderCustomCats();
  }

  // Słupek z zaokrąglonym końcem od strony wartości, płaski przy osi
  function barPath(x, w, y0, y1, rMax) {
    var h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    var r = Math.min(rMax || 4, w / 2, h);
    if (y1 < y0) {
      return 'M' + x + ',' + y0 + 'V' + (y1 + r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 +
        'H' + (x + w - r) + 'Q' + (x + w) + ',' + y1 + ' ' + (x + w) + ',' + (y1 + r) + 'V' + y0 + 'Z';
    }
    return 'M' + x + ',' + y0 + 'V' + (y1 - r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + y1 + ' ' + (x + w) + ',' + (y1 - r) + 'V' + y0 + 'Z';
  }
  function svgEl(W, H, label) {
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(label) + '">';
  }
  function chartWidth(node) { return Math.max(260, Math.round(node.clientWidth || 320)); }

  function renderSavingsChart(months, animate) {
    var N = 6;
    var end = selMonth > nowIdx - N ? nowIdx : selMonth;
    var idxs = [];
    for (var i = end - N + 1; i <= end; i++) idxs.push(i);
    var vals = idxs.map(function (i) { var m = months[i]; return m ? m.inc - m.exp : 0; });

    var W = chartWidth(el.savingsChart);
    var maxPos = Math.max(0, Math.max.apply(null, vals));
    var maxNeg = Math.max(0, -Math.min.apply(null, vals));
    var H = 184, top = 24, bottom = 26 + (maxNeg ? 18 : 0); // miejsce na etykietę pod ujemnym słupkiem
    var plotH = H - top - bottom;
    var span = maxPos + maxNeg;
    var y0 = span ? top + plotH * (maxPos / span) : top + plotH;
    var k = span ? plotH / span : 0;

    var sw = W / N;
    var bw = Math.min(28, sw * 0.48);
    var out = svgEl(W, H, 'Odłożone pieniądze w ostatnich miesiącach');
    out += '<line class="ch-axis" x1="0" x2="' + W + '" y1="' + y0 + '" y2="' + y0 + '"/>';
    idxs.forEach(function (mIdx, j) {
      var v = vals[j];
      var cx = sw * j + sw / 2;
      var x = cx - bw / 2;
      var y1 = y0 - v * k;
      var sel = mIdx === selMonth;
      var p = barPath(x, bw, y0, y1, 6);
      if (p) {
        out += '<path class="' + (v >= 0 ? 'ch-pos' : 'ch-neg') + (sel ? '' : ' ch-dim') + (animate ? ' ch-anim' : '') + '"' +
          (animate ? ' style="animation-delay:' + (j * 30) + 'ms"' : '') + ' d="' + p + '"/>';
      }
      out += '<text class="ch-tick' + (sel ? ' is-sel' : '') + '" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + MONTHS_SHORT[idxMonth(mIdx)] + '</text>';
      if (sel && months[mIdx]) {
        var ly = v >= 0 ? y1 - 7 : y1 + 15;
        var anchor = j === 0 ? 'start' : j === N - 1 ? 'end' : 'middle';
        var lx = j === 0 ? x : j === N - 1 ? x + bw : cx;
        out += '<text class="ch-val" x="' + lx + '" y="' + ly + '" text-anchor="' + anchor + '">' + moneyShort(v) + '</text>';
      }
      out += '<rect class="ch-hit" data-m="' + mIdx + '" x="' + (sw * j) + '" y="0" width="' + sw + '" height="' + H + '"><title>' +
        MONTHS[idxMonth(mIdx)] + ': ' + esc(signed(v)) + '</title></rect>';
    });
    out += '</svg>';
    el.savingsChart.innerHTML = out;
    el.savingsChart.dataset.w = el.savingsChart.clientWidth;

    var withData = idxs.filter(function (i) { return months[i]; });
    var hasNeg = vals.some(function (v) { return v < 0; });
    if (!withData.length) {
      el.savingsCaption.innerHTML = 'Dodawaj wpływy i wydatki, a tutaj zobaczysz, ile odkładasz co miesiąc.';
    } else {
      var avg = Math.round(withData.reduce(function (a, i) { return a + months[i].inc - months[i].exp; }, 0) / withData.length);
      el.savingsCaption.innerHTML = 'Średnio <b>' + signed(avg) + '</b> miesięcznie (' + plural(withData.length, 'miesiąc', 'miesiące', 'miesięcy') + ' z wpisami).' +
        (hasNeg ? ' Słupki pod osią to miesiące na minusie.' : '') + ' Stuknij słupek, aby wybrać miesiąc.';
    }
  }

  function renderCatStats(cur, animate) {
    var rows = Object.keys(cur.byCat).map(function (id) { return { c: catById(id), v: cur.byCat[id], n: cur.catCount[id] }; })
      .sort(function (a, b) { return b.v - a.v; });
    el.catStatsEmpty.hidden = rows.length > 0;
    el.catStats.hidden = rows.length === 0;
    if (!rows.length) { el.catStats.innerHTML = ''; return; }
    var max = rows[0].v;
    el.catStats.innerHTML = rows.map(function (r, i) {
      var share = cur.exp ? Math.round(r.v / cur.exp * 100) : 0;
      return '<li><div class="row cat-stat">' +
        '<span class="row-icon cat-icon" style="background-color:' + r.c.color + '">' + icon(r.c.icon) + '</span>' +
        '<span class="row-body">' +
          '<span class="cat-stat-top"><span class="row-title">' + esc(r.c.name) + '</span><span class="cat-stat-amount">' + money(r.v) + '</span></span>' +
          '<span class="cat-stat-bottom"><span class="meter"><span style="width:' + Math.max(2, r.v / max * 100).toFixed(1) + '%' +
          (animate ? ';animation-delay:' + (i * 40) + 'ms' : ';animation:none') + '"></span></span>' +
          '<span class="cat-stat-pct">' + share + '%</span></span>' +
          '<span class="cat-stat-count">' + plural(r.n, 'wydatek', 'wydatki', 'wydatków') + '</span>' +
        '</span></div></li>';
    }).join('');
  }

  function renderDailyChart(cur, animate) {
    var y = idxYear(selMonth), m = idxMonth(selMonth);
    var days = new Date(y, m + 1, 0).getDate();
    var elapsed = selMonth === nowIdx ? new Date().getDate() : days;
    var vals = [];
    for (var d = 1; d <= days; d++) vals.push(cur.days[d] || 0);
    var max = Math.max.apply(null, vals);

    var W = chartWidth(el.dailyChart);
    var H = 130, top = 16, bottom = 22;
    var plotH = H - top - bottom;
    var y0 = top + plotH;
    var k = max ? plotH / max : 0;
    var sw = W / days;
    var bw = Math.max(3, Math.min(9, sw * 0.6));
    var lastWeekly = Math.floor((days - 1) / 7) * 7 + 1;

    var out = svgEl(W, H, 'Wydatki w kolejnych dniach miesiąca');
    if (max) {
      out += '<line class="ch-grid" x1="0" x2="' + W + '" y1="' + top + '" y2="' + top + '"/>';
      out += '<text class="ch-tick" x="' + W + '" y="' + (top - 5) + '" text-anchor="end">' + moneyShort(max).replace('+', '') + '</text>';
    }
    out += '<line class="ch-axis" x1="0" x2="' + W + '" y1="' + y0 + '" y2="' + y0 + '"/>';
    vals.forEach(function (v, j) {
      var day = j + 1;
      var cx = sw * j + sw / 2;
      var p = barPath(cx - bw / 2, bw, y0, y0 - v * k, 3);
      var dim = selDay && selDay !== day;
      if (p) out += '<path class="ch-pos' + (dim ? ' ch-dim' : '') + (animate ? ' ch-anim' : '') + '" d="' + p + '"/>';
      var weekly = day % 7 === 1;
      var showLast = day === days && !weekly && days - lastWeekly >= 3;
      if (weekly || showLast) {
        out += '<text class="ch-tick' + (selDay === day ? ' is-sel' : '') + '" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + day + '</text>';
      }
      out += '<rect class="ch-hit" data-d="' + day + '" x="' + (sw * j) + '" y="0" width="' + sw + '" height="' + H + '"/>';
    });
    out += '</svg>';
    el.dailyChart.innerHTML = out;

    if (selDay && selDay <= days) {
      var v = cur.days[selDay] || 0;
      el.dailyReadout.innerHTML = '<b>' + esc(dayLongFmt.format(new Date(y, m, selDay))) + '</b>: ' + money(v) +
        (cur.dayCount[selDay] ? ' (' + plural(cur.dayCount[selDay], 'wydatek', 'wydatki', 'wydatków') + ')' : '');
    } else if (cur.exp) {
      el.dailyReadout.innerHTML = 'Średnio <b>' + money(Math.round(cur.exp / elapsed)) + '</b> dziennie. Stuknij słupek, aby zobaczyć dzień.';
    } else {
      el.dailyReadout.textContent = 'Brak wydatków w tym miesiącu.';
    }
  }

  // Własne grupy (Statystyki)
  var addingCat = false, catDraft = '', focusNewCat = false;
  function renderCustomCats() {
    var prev = $('newCatInput');
    if (prev && addingCat) catDraft = prev.value;
    var u = catUsage();
    var rows = state.customCats.map(function (c) {
      var n = u[c.id] || 0;
      return '<li><div class="row">' +
        '<span class="row-icon cat-icon" style="background-color:' + c.color + '">' + icon(c.icon) + '</span>' +
        '<span class="row-body"><span class="row-title">' + esc(c.name) + '</span><span class="row-sub">' + (n ? plural(n, 'wydatek', 'wydatki', 'wydatków') : 'Brak wydatków') + '</span></span>' +
        '<button class="row-del" data-del-cat="' + esc(c.id) + '" aria-label="Usuń grupę ' + esc(c.name) + '">' + icon('trash') + '</button>' +
        '</div></li>';
    });
    if (addingCat) {
      rows.push('<li class="row row--input"><span class="row-icon row-icon--blue">' + icon('tag') + '</span>' +
        '<input id="newCatInput" type="text" maxlength="24" placeholder="Nazwa nowej grupy" enterkeyhint="done" value="' + esc(catDraft) + '">' +
        '<button class="text-btn" id="newCatCancel">Anuluj</button>' +
        '<button class="text-btn text-btn--bold" id="newCatSave">Dodaj</button></li>');
    }
    el.customCats.innerHTML = rows.join('');
    el.customCats.hidden = rows.length === 0;
    el.customCatsHint.hidden = state.customCats.length > 0 || addingCat;
    el.addCatBtn.hidden = addingCat;
    if (addingCat) {
      var inp = $('newCatInput');
      var done = function () {
        if (!inp.value.trim()) { inp.focus(); return; }
        var r = addCustomCat(inp.value);
        addingCat = false; catDraft = '';
        renderCustomCats();
        if (r.created) showDone('Dodano grupę: ' + r.cat.name);
        else toast('Grupa „' + r.cat.name + '” już istnieje', 'info');
      };
      var cancel = function () { addingCat = false; catDraft = ''; renderCustomCats(); };
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); done(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      });
      $('newCatSave').addEventListener('click', done);
      $('newCatCancel').addEventListener('click', cancel);
      if (focusNewCat) { focusNewCat = false; inp.focus(); }
    }
  }

  // ---------- Arkusze: stos otwartych paneli ----------
  // Każdy otwarty panel dostaje kolejną warstwę; tło (backdrop) leży tuż pod najwyższym,
  // a niższe panele są nieaktywne (inert), więc da się używać tylko tego na wierzchu.
  var PANELS = [el.sheet, el.loansSheet, el.personSheet, el.historySheet, el.entrySheet, el.catSheet, el.actionSheet, $('guideSheet')];
  var stack = [];
  var zTop = 50;      // warstwy rosną z każdym otwarciem, więc zamykany panel nigdy nie zasłoni nowego
  var openedAt = 0;   // chroni przed zamknięciem panelu tym samym (podwójnym) stuknięciem, które go otworzyło
  function isOpen(panel) { return panel.dataset.open === '1'; }
  function anyOpen() { return stack.length > 0; }
  function topPanel() { return stack[stack.length - 1] || null; }
  function layoutStack() {
    stack.forEach(function (p, i) {
      if (i === stack.length - 1) p.removeAttribute('inert'); else p.setAttribute('inert', '');
    });
    var top = topPanel();
    if (top) el.backdrop.style.zIndex = Number(top.style.zIndex) - 1;
  }
  function openPanel(panel) {
    clearTimeout(panel._hideT);
    var i = stack.indexOf(panel);
    if (i !== -1) stack.splice(i, 1);
    stack.push(panel);
    zTop += 2;
    panel.style.zIndex = zTop;
    openedAt = Date.now();
    panel.dataset.open = '1';
    layoutStack();
    document.body.classList.add('no-scroll');
    el.backdrop.hidden = false;
    panel.hidden = false;
    panel.style.transform = '';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!isOpen(panel)) return;
        el.backdrop.classList.add('is-open');
        panel.classList.add('is-open');
      });
    });
  }
  function closePanel(panel) {
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    var i = stack.indexOf(panel);
    if (i !== -1) stack.splice(i, 1);
    panel.dataset.open = '0';
    panel.classList.remove('is-open');
    panel.style.transform = '';
    panel.setAttribute('inert', '');
    layoutStack();
    if (!anyOpen()) {
      el.backdrop.classList.remove('is-open');
      document.body.classList.remove('no-scroll');
    }
    clearTimeout(panel._hideT);
    panel._hideT = setTimeout(function () {
      if (!isOpen(panel)) { panel.hidden = true; panel.removeAttribute('inert'); }
      if (!anyOpen()) {
        el.backdrop.hidden = true;
        if (PANELS.every(function (p) { return p.hidden; })) zTop = 50;
      }
    }, 400);
  }
  // Zamknięcie z właściwym sprzątaniem dla każdego panelu
  function closeAny(panel) {
    if (panel === el.sheet) closeEdit();
    else if (panel === el.personSheet) closePerson();
    else if (panel === el.entrySheet) closeEntry();
    else if (panel === el.actionSheet) closeActions();
    else closePanel(panel);
  }
  function closeTop() { var p = topPanel(); if (p) closeAny(p); }

  function setSegment(control, attr, value) {
    var btns = Array.prototype.filter.call(control.querySelectorAll('button[' + attr + ']'), function (b) { return !b.hidden; });
    control.style.setProperty('--n', btns.length);
    btns.forEach(function (b, i) {
      var on = b.getAttribute(attr) === value;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) control.querySelector('.segmented-thumb').style.transform = 'translateX(' + (i * 100) + '%)';
    });
  }

  // ---------- Arkusz edycji kwoty ----------
  // ctx: { type: 'source', key } | { type: 'loan', id, mode } | { type: 'newLoan' }
  var ctx = null;
  var mode = 'set';
  var fund = 'cash';
  var selCat = null;
  var lastGoodAmount = '';

  var MODE_LABELS = {
    source: { set: 'Ustaw', add: 'Dodaj', sub: 'Odejmij', move: 'Przenieś' },
    loan: { set: 'Popraw kwotę', add: 'Pożycz więcej', sub: 'Spłata', move: '' }
  };

  function currentValue() {
    if (!ctx) return 0;
    if (ctx.type === 'source') return state[ctx.key];
    if (ctx.type === 'loan') { var l = findLoan(ctx.id); return l ? l.amount : 0; }
    return 0;
  }

  function openEdit(c) {
    if (c.type === 'loan' && !findLoan(c.id)) return;
    ctx = c;
    var isSource = c.type === 'source';
    var labels = MODE_LABELS[isSource ? 'source' : 'loan'];
    el.modeControl.querySelectorAll('button[data-mode]').forEach(function (b) {
      var m = b.getAttribute('data-mode');
      b.textContent = labels[m];
      b.hidden = m === 'move' && !isSource;
    });

    if (isSource) {
      el.sheetTitle.textContent = SOURCES[c.key].name;
      el.sheetCurrentLabel.textContent = 'Obecnie';
    } else if (c.type === 'loan') {
      el.sheetTitle.textContent = labels[c.mode || 'sub'] + ': ' + findLoan(c.id).name;
      el.sheetCurrentLabel.textContent = 'Do oddania';
    } else {
      el.sheetTitle.textContent = 'Nowa pożyczka';
    }
    // Dla pożyczek tryb wybiera się przyciskiem na ekranie osoby, więc bez przełącznika
    el.modeControl.hidden = !isSource;
    el.nameGroup.hidden = c.type !== 'newLoan';
    el.sheetCurrent.parentNode.hidden = c.type === 'newLoan';
    el.sheetCurrent.textContent = money(currentValue());
    el.nameInput.value = '';
    el.noteInput.value = '';
    el.sheetError.hidden = true;
    fund = state.lastFund || 'cash';
    setSegment(el.fundControl, 'data-fund', fund);
    selCat = null;
    if (isSource) renderCatButton('catPick', null);

    var startMode = c.type === 'newLoan' ? 'add' : c.type === 'loan' ? (c.mode || 'sub') : (state[c.key + 'At'] ? 'sub' : 'set');
    setMode(startMode, true);

    el.sheet.scrollTop = 0;
    openPanel(el.sheet);
    // iOS pokaże klawiaturę tylko przy focus w obrębie gestu użytkownika
    (c.type === 'newLoan' ? el.nameInput : el.amountInput).focus({ preventScroll: true });
  }

  function closeEdit() {
    closePanel(el.sheet);
  }

  function setMode(m, resetValue) {
    mode = m;
    setSegment(el.modeControl, 'data-mode', m);
    var sign = { add: '+', sub: '−', set: '', move: '' }[m];
    el.amountSign.textContent = ctx.type === 'source' ? sign : '';
    el.amountSign.className = 'amount-sign' + (m === 'add' ? ' pos' : m === 'sub' ? ' neg' : '');
    if (resetValue) {
      var cur = currentValue();
      // Ujemnego stanu nie da się wpisać w pole kwoty — wtedy zaczynamy od pustego pola
      var setPrefill = m === 'set' && cur >= 0 && (ctx.type === 'loan' || (ctx.type === 'source' && state[ctx.key + 'At']));
      el.amountInput.value = setPrefill ? toInput(cur) : '';
      lastGoodAmount = el.amountInput.value;
    }
    el.catBlock.hidden = !(ctx.type === 'source' && m === 'sub');
    el.moveHint.hidden = !(ctx.type === 'source' && m === 'move');
    el.fundBlock.hidden = !(ctx.type !== 'source' && m !== 'set');
    el.fundLabel.textContent = m === 'sub' ? 'Spłata trafia do' : 'Pieniądze pochodzą z';
    el.fillAllBtn.hidden = !(ctx.type === 'loan' && m === 'sub');
    if (!el.fillAllBtn.hidden) el.fillAllBtn.textContent = 'Spłata całości (' + money(currentValue()) + ')';
    el.noteInput.placeholder = m === 'sub' && ctx.type === 'source' ? 'Na co? (opcjonalnie)' : 'Notatka (opcjonalnie)';
    el.sheetError.hidden = true;
    updatePreview();
  }

  function toInput(grosze) { return (grosze / 100).toFixed(2).replace('.', ','); }

  function computeNew() {
    var v = parseAmount(el.amountInput.value);
    if (isNaN(v)) return null;
    var cur = currentValue();
    if (mode === 'set') return v;
    if (mode === 'add') return cur + v;
    return cur - v; // sub i move
  }

  function updatePreview() {
    if (!ctx) return;
    // Długie kwoty: mniejsza czcionka, żeby mieściły się w polu
    var len = el.amountInput.value.length;
    el.amountInput.classList.toggle('is-long', len >= 8 && len < 11);
    el.amountInput.classList.toggle('is-xlong', len >= 11);
    var v = parseAmount(el.amountInput.value);
    var n = computeNew();
    var valid = n !== null && !(mode !== 'set' && v === 0) && !(ctx.type === 'loan' && n < 0) && Math.abs(n) <= MAX_GROSZE;
    el.sheetSave.disabled = !valid;
    el.sheetPreview.style.visibility = n === null || ctx.type === 'newLoan' ? 'hidden' : '';
    if (n !== null) {
      el.previewValue.textContent = money(n);
      el.sheetPreview.classList.toggle('is-negative', n < 0);
    }
    var amt = isNaN(v) ? 0 : v;
    updateFundHint(amt);
    if (!el.moveHint.hidden) {
      var o = other(ctx.key);
      el.moveHint.innerHTML = (ctx.key === 'cash' ? 'Wpłata gotówki na konto. ' : 'Wypłata z konta do gotówki. ') +
        SOURCES[o].short + ': <b>' + money(state[o]) + '</b> → <b>' + money(state[o] + amt) + '</b>. Łączna suma bez zmian, nie liczy się jako wydatek.';
    }
  }

  function updateFundHint(v) {
    if (el.fundBlock.hidden) return;
    var sign = mode === 'sub' ? 1 : -1;
    if (fund === 'none') {
      var t = state.cash + state.bank + loansTotal();
      el.fundHint.innerHTML = mode === 'sub'
        ? 'Łączna suma zmniejszy się: <b>' + money(t) + '</b> → <b>' + money(t - v) + '</b>'
        : 'Łączna suma wzrośnie: <b>' + money(t) + '</b> → <b>' + money(t + v) + '</b>';
    } else {
      var cur = state[fund];
      el.fundHint.innerHTML = SOURCES[fund].short + ': <b>' + money(cur) + '</b> → <b>' + money(cur + sign * v) + '</b>. Łączna suma bez zmian.';
    }
  }

  // Pole kwoty: cyfry i jeden przecinek, maks. 9 cyfr przed przecinkiem i 2 po.
  // Przy wklejeniu „1.234,56” ostatni separator jest dziesiętny, pozostałe są pomijane.
  function sanitizeInput() {
    var raw = el.amountInput.value.replace(/[^\d.,]/g, '');
    var lastSep = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
    var intPart = raw, frac = null;
    if (lastSep >= 0) {
      intPart = raw.slice(0, lastSep).replace(/[.,]/g, '');
      frac = raw.slice(lastSep + 1).replace(/[.,]/g, '').slice(0, 2);
    }
    intPart = intPart.replace(/^0+(?=\d)/, '');
    if (intPart.length > 9) { el.amountInput.value = lastGoodAmount; return; }
    var v = frac !== null ? (intPart || '0') + ',' + frac : intPart;
    if (v !== el.amountInput.value) el.amountInput.value = v;
    lastGoodAmount = v;
  }

  function applyFund(f, delta, now) {
    if ((f !== 'cash' && f !== 'bank') || !delta) return;
    state[f] += delta;
    state[f + 'At'] = now;
  }

  function pushHistory(entry) {
    entry.id = uid();
    state.history.unshift(entry);
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    lastNewId = entry.id;
    setTimeout(function () { if (lastNewId === entry.id) lastNewId = null; }, 1500);
    return entry;
  }

  function addShares(f, ch) { FUND_KEYS.forEach(function (k) { f[k] += ch[k] || 0; }); }

  function commit() {
    // Zabezpieczenie przed podwójnym zapisem: zamykany arkusz od razu przestaje być „otwarty”,
    // więc drugie Enter/stuknięcie podczas animacji niczego nie zapisze
    if (!ctx || !isOpen(el.sheet)) return;
    if (ctx.type === 'loan' && !findLoan(ctx.id)) { closeEdit(); return; }
    var v = parseAmount(el.amountInput.value);
    var n = computeNew();
    var note = el.noteInput.value.trim();
    var now = Date.now();
    var msg;
    if (n !== null && Math.abs(n) > MAX_GROSZE) { showError('Kwota jest za duża.'); return; }
    if (ctx.type === 'newLoan' && !isNaN(v)) {
      var ex = findLoanByName(el.nameInput.value.trim().replace(/\s+/g, ' '));
      if (ex && ex.amount + v > MAX_GROSZE) { showError('Kwota jest za duża.'); return; }
    }

    if (ctx.type === 'newLoan') {
      var name = el.nameInput.value.trim().replace(/\s+/g, ' ');
      if (!name) { showError('Wpisz, komu pożyczasz.'); el.nameInput.focus(); return; }
      if (isNaN(v) || v <= 0) { showError('Wpisz kwotę większą od zera.'); return; }
      var loan = findLoanByName(name);
      if (!loan) { loan = { id: uid(), name: name, amount: 0, since: now, note: '', funds: emptyFunds() }; state.loans.push(loan); }
      var f0 = fundsOf(loan);
      var k0 = fundKey(fund);
      var before = loan.amount;
      loan.amount += v;
      f0[k0] += v;
      loan.at = now;
      if (note) loan.note = note;
      applyFund(fund, -v, now);
      state.lastFund = fund;
      state.loansAt = now;
      var sh0 = emptyFunds(); sh0[k0] = v;
      pushHistory({ source: 'loan', name: loan.name, mode: 'add', fund: fund, before: before, after: loan.amount, at: now, note: note, shares: sh0, loanSince: loan.since });
      msg = 'Pożyczka zapisana';
    } else if (ctx.type === 'loan') {
      var l = findLoan(ctx.id);
      if (n === null) { showError('Wpisz poprawną kwotę.'); return; }
      if (mode !== 'set' && v === 0) { showError('Kwota musi być większa od zera.'); return; }
      if (n < 0) { showError('Spłata nie może być większa niż pożyczka (' + money(l.amount) + ').'); return; }
      var f = fundsOf(l);
      var k = fundKey(fund);
      var b = l.amount;
      var shares;
      if (mode === 'add') { applyFund(fund, -v, now); shares = emptyFunds(); shares[k] = v; addShares(f, shares); }
      else if (mode === 'sub') { applyFund(fund, v, now); shares = reduceShares(f, v, repayOrder(k)); }
      else {
        var d = n - b;
        if (d >= 0) { shares = emptyFunds(); shares.none = d; addShares(f, shares); }
        else shares = reduceShares(f, -d, ['none', 'cash', 'bank']);
      }
      if (mode !== 'set') state.lastFund = fund;
      l.amount = n;
      normFunds(f, n);
      l.at = now;
      state.loansAt = now;
      pushHistory({ source: 'loan', name: l.name, mode: mode, fund: mode === 'set' ? 'none' : fund, before: b, after: n, at: now, note: note, shares: shares, loanSince: l.since });
      if (n === 0) {
        state.loans = state.loans.filter(function (x) { return x.id !== l.id; });
        msg = l.name + ': rozliczone';
      } else {
        msg = mode === 'sub' ? 'Spłata zapisana' : mode === 'add' ? 'Pożyczka zapisana' : 'Kwota poprawiona';
      }
    } else {
      if (n === null) { showError('Wpisz poprawną kwotę.'); return; }
      var key = ctx.key;
      var bf = state[key];
      if (mode !== 'set' && v === 0) { showError('Kwota musi być większa od zera.'); return; }
      if (mode === 'move') {
        var o = other(key);
        state[key] -= v; state[o] += v;
        state[key + 'At'] = now; state[o + 'At'] = now;
        pushHistory({ source: key, mode: 'move', to: o, amount: v, before: bf, after: state[key], at: now, note: note });
        msg = key === 'cash' ? 'Przeniesiono na konto' : 'Przeniesiono do gotówki';
      } else {
        state[key] = n;
        state[key + 'At'] = now;
        var entry = { source: key, mode: mode, before: bf, after: n, at: now, note: note };
        if (mode === 'sub') entry.cat = selCat || 'other';
        pushHistory(entry);
        msg = mode === 'sub' ? catById(entry.cat).name + ': ' + money(v) : mode === 'add' ? 'Wpływ: ' + money(v) : SOURCES[key].name + ': zapisano';
      }
    }
    el.sheetSave.disabled = true;
    save();
    render();
    closeEdit();
    showDone(msg);
  }

  function shakeAmount() {
    el.amountField.classList.remove('is-invalid');
    void el.amountField.offsetWidth;
    el.amountField.classList.add('is-invalid');
  }
  function showError(msg) {
    el.sheetError.textContent = msg;
    el.sheetError.hidden = false;
    shakeAmount();
  }

  // ---------- Ekran osoby (pożyczka) ----------
  var personId = null;

  function openPerson(id) {
    if (!findLoan(id)) return;
    personId = id;
    renderPerson();
    el.personSheet.querySelector('.sheet-scroll').scrollTop = 0;
    openPanel(el.personSheet);
  }
  function closePerson() { personId = null; closePanel(el.personSheet); }

  function renderPerson() {
    if (!personId) return;
    var l = findLoan(personId);
    if (!l) { if (isOpen(el.personSheet)) closePerson(); return; }
    var src = fundsLabel(fundsOf(l));
    el.personTitle.textContent = l.name;
    el.personAvatar.textContent = initials(l.name);
    el.personAmount.textContent = money(l.amount);
    el.personMeta.textContent = 'Pożyczone od ' + dayLongFmt.format(new Date(l.since)) + (src ? ' · ' + src : '');
    var entries = state.history.filter(function (e) { return e.source === 'loan' && sameName(e.name, l.name); });
    el.personHistory.innerHTML = entries.map(function (e) {
      var d = describe(e);
      return '<li><button class="row hist-row' + (e.id === lastNewId ? ' is-new' : '') + '" data-entry="' + esc(e.id) + '">' + iconBadge(d) +
        '<span class="row-body"><span class="row-title">' + esc(d.sub) + '</span><span class="row-sub">' + esc((e.note ? e.note + ' · ' : '') + when(e.at)) + '</span></span>' +
        '<span class="hist-right"><span class="hist-delta amount loan">' + signed(d.delta) + '</span><span class="hist-after amount">' + money(e.after) + '</span></span>' +
        '</button></li>';
    }).join('');
    el.personHistory.hidden = entries.length === 0;
  }

  function deleteLoan(id) {
    var l = findLoan(id);
    if (!l) return;
    var f = fundsOf(l);
    var remove = function (giveBack) {
      if (!findLoan(l.id)) return; // już usunięta (podwójne stuknięcie)
      var now = Date.now();
      var returned = { cash: giveBack ? f.cash : 0, bank: giveBack ? f.bank : 0 };
      applyFund('cash', returned.cash, now);
      applyFund('bank', returned.bank, now);
      var shares = { cash: -f.cash, bank: -f.bank, none: -f.none };
      state.loans = state.loans.filter(function (x) { return x.id !== l.id; });
      state.loansAt = now;
      pushHistory({ source: 'loan', name: l.name, mode: 'del', fund: 'none', before: l.amount, after: 0, at: now, note: '',
        shares: shares, returned: returned, writeOff: !giveBack && (f.cash + f.bank) > 0, loanSince: l.since });
      save();
      render();
      if (isOpen(el.personSheet)) closePerson();
      if (giveBack) showDone('Pożyczka cofnięta'); else toast('Pożyczka usunięta', 'delete');
    };
    var back = returnedLabel({ cash: f.cash, bank: f.bank });
    if (back) {
      actionChoices('Usunąć pożyczkę: ' + l.name + ' (' + money(l.amount) + ')? Możesz oddać pieniądze tam, skąd wyszły, jakby pożyczki nie było, albo spisać je na straty (łączna suma zmniejszy się).', [
        { text: 'Oddaj ' + back, cb: function () { remove(true); } },
        { text: 'Spisz na straty', danger: true, cb: function () { remove(false); } }
      ]);
    } else {
      confirmAction('Usunąć pożyczkę: ' + l.name + ' (' + money(l.amount) + ')? Była zapisana bez zmiany gotówki i konta, więc łączna suma zmniejszy się o tę kwotę.', 'Usuń pożyczkę', function () { remove(false); });
    }
  }

  // ---------- Arkusz szczegółów wpisu ----------
  var entryId = null;
  var entryCat = null;

  // Skutki cofnięcia wpisu pożyczki
  function loanRevert(e) {
    var d = e.after - e.before;
    var l = findLoanByName(e.name);
    var cur = l ? l.amount : 0;
    // Zmiana gotówki/konta przy cofnięciu
    var fd = { cash: 0, bank: 0 };
    if (e.returned) { fd.cash = -(e.returned.cash || 0); fd.bank = -(e.returned.bank || 0); }
    else if (e.fund === 'cash' || e.fund === 'bank') fd[e.fund] = d;
    return { d: d, loan: l, cur: cur, next: cur - d, fd: fd };
  }
  // Data rozpoczęcia pożyczki zamkniętej wpisem z chwili beforeTs (dla starszych wpisów bez loanSince)
  function oldestLoanAt(name, beforeTs) {
    var at = null;
    state.history.filter(function (x) { return x.source === 'loan' && sameName(x.name, name) && x.at < beforeTs; })
      .sort(function (a, b) { return a.at - b.at; })
      .forEach(function (x) {
        if (x.mode === 'del' || x.after === 0) at = null;
        else if (at === null && x.after > 0) at = x.at;
      });
    return at;
  }

  function entryHint(e) {
    if (e.source === 'loan') {
      var r = loanRevert(e);
      if (r.next < 0) {
        return { blocked: true, text: 'Nie można usunąć: ' + e.name + ' ma teraz do oddania ' + money(r.cur) + ', a ten wpis dotyczy ' + money(Math.abs(r.d)) + '. Usuń najpierw nowsze wpisy tej osoby.' };
      }
      var parts = ['Pożyczka (' + e.name + '): ' + money(r.cur) + ' → ' + money(r.next) + '.'];
      ['cash', 'bank'].forEach(function (k) {
        if (r.fd[k]) parts.push(SOURCES[k].short + ': ' + money(state[k]) + ' → ' + money(state[k] + r.fd[k]) + '.');
      });
      var totalChange = r.fd.cash + r.fd.bank - r.d;
      if (totalChange) parts.push('Łączna suma zmieni się o ' + signed(totalChange) + '.');
      return { blocked: false, text: 'Usunięcie cofnie ten wpis. ' + parts.join(' ') };
    }
    var src = SOURCES[e.source].short;
    var amt = Math.abs(e.after - e.before);
    return { blocked: false, text: 'Usunięcie cofnie ten wpis: ' + ({
      add: src + ' zmniejszy się o ' + money(amt) + '.',
      sub: src + ' wzrośnie o ' + money(amt) + '.',
      set: src + ' zmieni się o ' + signed(e.before - e.after) + '.',
      move: src + ' wzrośnie, a ' + (e.to ? SOURCES[e.to].short.toLowerCase() : '') + ' zmniejszy się o ' + money(e.amount || 0) + '.'
    }[e.mode] || '') };
  }

  function fillEntry(e) {
    var d = describe(e);
    el.entryIcon.className = 'entry-icon ' + d.cls;
    el.entryIcon.style.backgroundColor = d.bg || '';
    el.entryIcon.innerHTML = icon(d.ic);
    el.entryAmount.textContent = e.mode === 'move' ? money(e.amount) : signed(d.delta);
    el.entryMeta.textContent = d.sub + ' · ' + fullFmt.format(new Date(e.at));
    var h = entryHint(e);
    el.entryDeleteHint.textContent = h.text;
    el.entryDelete.disabled = h.blocked;
  }

  function openEntry(id) {
    var e = findEntry(id);
    if (!e) return;
    entryId = id;
    fillEntry(e);
    el.entryNote.value = e.note || '';
    var exp = isExpense(e);
    el.entryCatBlock.hidden = !exp;
    entryCat = e.cat || 'other';
    if (exp) renderCatButton('entryCatPick', entryCat);
    openPanel(el.entrySheet);
  }
  function closeEntry() { entryId = null; closePanel(el.entrySheet); }
  // Po zmianach gdzie indziej: odśwież albo zamknij otwarte szczegóły wpisu
  function refreshEntry() {
    if (!entryId || !isOpen(el.entrySheet)) return;
    var e = findEntry(entryId);
    if (!e) { closeEntry(); return; }
    fillEntry(e);
  }

  function saveEntry() {
    if (!isOpen(el.entrySheet)) return;
    var e = findEntry(entryId);
    if (!e) { closeEntry(); return; }
    e.note = el.entryNote.value.trim().slice(0, 60);
    if (isExpense(e)) e.cat = entryCat || 'other';
    save();
    render();
    closeEntry();
    showDone('Zapisano zmiany');
  }

  function deleteEntry() {
    var e0 = findEntry(entryId);
    if (!e0) return;
    var h = entryHint(e0);
    if (h.blocked) return;
    var id = e0.id;
    confirmAction('Usunąć ten wpis? ' + h.text.replace(/^Usunięcie cofnie ten wpis[:.] /, ''), 'Usuń wpis', function () {
      var e = findEntry(id);
      if (!e) return; // już usunięty (podwójne stuknięcie)
      var now = Date.now();
      if (e.source === 'loan') {
        var r = loanRevert(e);
        if (r.next < 0) return;
        var l = r.loan;
        if (!l && r.next > 0) {
          // Cofnięcie wpisu zamykającego pożyczkę — odtwórz ją z pierwotną datą
          l = { id: uid(), name: e.name, amount: 0, since: e.loanSince || oldestLoanAt(e.name, e.at) || e.at, note: '', funds: emptyFunds() };
          state.loans.push(l);
        }
        // Usuń wpis, a udziały pożyczki (gotówka / konto / bez zmian) odbuduj z pozostałej historii —
        // dzięki temu kolejność usuwania wpisów nie ma znaczenia
        state.history = state.history.filter(function (x) { return x.id !== e.id; });
        if (l) {
          l.amount = r.next;
          l.at = now;
          l.funds = null;
          fundsOf(l);
          if (r.next === 0) state.loans = state.loans.filter(function (x) { return x.id !== l.id; });
        }
        applyFund('cash', r.fd.cash, now);
        applyFund('bank', r.fd.bank, now);
        state.loansAt = now;
      } else if (e.mode === 'move') {
        state[e.source] += e.amount;
        state[e.to] -= e.amount;
        state[e.to + 'At'] = now;
        state[e.source + 'At'] = now;
      } else {
        state[e.source] -= (e.after - e.before);
        state[e.source + 'At'] = now;
      }
      state.history = state.history.filter(function (x) { return x.id !== e.id; });
      save();
      render();
      closeEntry();
      toast('Wpis usunięty', 'delete');
    });
  }

  // ---------- Przeciąganie arkuszy w dół (zamykanie gestem) ----------
  [el.sheet, el.loansSheet, el.personSheet, el.historySheet, el.entrySheet, el.catSheet].forEach(function (panel) {
    var startY = 0, dy = 0, dragging = false, touchId = null;
    var findTouch = function (list) {
      for (var i = 0; i < list.length; i++) if (list[i].identifier === touchId) return list[i];
      return null;
    };
    [panel.querySelector('.sheet-grabber'), panel.querySelector('.sheet-header')].forEach(function (h) {
      h.addEventListener('touchstart', function (e) {
        if (e.target.closest('button') || dragging || topPanel() !== panel) return;
        var t = e.changedTouches[0];
        dragging = true; touchId = t.identifier; startY = t.clientY; dy = 0;
        panel.classList.add('is-dragging');
      }, { passive: true });
    });
    window.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var t = findTouch(e.changedTouches);
      if (!t) return;
      dy = Math.max(0, t.clientY - startY);
      panel.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    var end = function (e, cancelled) {
      if (!dragging || !findTouch(e.changedTouches)) return;
      dragging = false; touchId = null;
      panel.classList.remove('is-dragging');
      if (!cancelled && dy > 110) closeAny(panel);
      else panel.style.transform = '';
    };
    window.addEventListener('touchend', function (e) { end(e, false); });
    window.addEventListener('touchcancel', function (e) { end(e, true); });
  });

  // ---------- Action sheet (potwierdzenia) ----------
  // buttons: [{ text, danger, bold, cb }] — każde potwierdzenie wykona się najwyżej raz.
  // onCancel — wywołane, gdy arkusz zamknięto bez wyboru (Anuluj, tło, Escape, nowy arkusz akcji).
  var actionCancelCb = null;
  function actionChoices(title, buttons, onCancel) {
    if (actionCancelCb) { var prev = actionCancelCb; actionCancelCb = null; prev(); }
    el.actionTitle.textContent = title;
    el.actionGroup.querySelectorAll('.action-btn').forEach(function (b) { b.remove(); });
    var fired = false;
    buttons.forEach(function (btn) {
      var b = document.createElement('button');
      b.className = 'action-btn' + (btn.danger ? ' action-btn--danger' : '') + (btn.bold ? ' action-btn--bold' : '');
      b.textContent = btn.text;
      b.addEventListener('click', function () {
        if (fired || !isOpen(el.actionSheet)) return;
        fired = true;
        actionCancelCb = null;
        closePanel(el.actionSheet);
        btn.cb();
      });
      el.actionGroup.appendChild(b);
    });
    actionCancelCb = onCancel || null;
    openPanel(el.actionSheet);
  }
  function confirmAction(title, btnText, cb) { actionChoices(title, [{ text: btnText, danger: true, cb: cb }]); }
  function closeActions() {
    var c = actionCancelCb;
    actionCancelCb = null;
    closePanel(el.actionSheet);
    if (c) c();
  }

  // ---------- Toast i animacja potwierdzenia ----------
  var toastTimer, toastHideTimer;
  // kind: 'success' (fajka) | 'delete' (kosz) | 'info' (bez ikony)
  function toast(msg, kind) {
    kind = kind || 'success';
    el.toast.className = 'toast toast--' + kind;
    el.toastIcon.innerHTML = kind === 'delete' ? icon('trash') : kind === 'success' ? icon('check') : '';
    el.toastText.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer); clearTimeout(toastHideTimer);
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.toast.classList.add('is-open'); }); });
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('is-open');
      toastHideTimer = setTimeout(function () { if (!el.toast.classList.contains('is-open')) el.toast.hidden = true; }, 420);
    }, 2000);
  }

  var doneTimers = [];
  function showDone(text) {
    doneTimers.forEach(clearTimeout);
    doneTimers = [];
    var hud = el.doneHud;
    el.doneText.textContent = text;
    hud.classList.remove('is-play', 'is-out');
    hud.hidden = false;
    void hud.offsetWidth;
    doneTimers.push(setTimeout(function () { hud.classList.add('is-play'); }, REDUCED.matches ? 0 : 120));
    doneTimers.push(setTimeout(function () { hud.classList.add('is-out'); }, REDUCED.matches ? 1100 : 1270));
    doneTimers.push(setTimeout(function () { hud.hidden = true; hud.classList.remove('is-play', 'is-out'); }, REDUCED.matches ? 1300 : 1520));
  }

  // ---------- Kopia zapasowa ----------
  function backupJson() {
    return JSON.stringify({ app: 'saldo', version: 1, exportedAt: new Date().toISOString(), data: state }, null, 1);
  }
  function exportBackup() {
    var json = backupJson();
    var name = 'saldo-kopia-' + ymd(new Date()) + '.json';
    var file = null;
    try { file = new File([json], name, { type: 'application/json' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Kopia Saldo' }).then(function () { showDone('Kopia zapisana'); }).catch(function () { /* anulowano */ });
      return;
    }
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    showDone('Kopia zapisana');
  }
  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
        if (parsed && parsed.app === 'saldo' && parsed.data) parsed = parsed.data;
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.history)) throw new Error('format');
      } catch (e) { toast('To nie jest plik kopii Saldo', 'info'); return; }
      var next = migrate(parsed);
      confirmAction('Wczytać kopię? Obecne dane (' + plural(state.history.length, 'wpis', 'wpisy', 'wpisów') + ') zostaną zastąpione danymi z kopii (' +
        plural(next.history.length, 'wpis', 'wpisy', 'wpisów') + ', łącznie ' + money(next.cash + next.bank + next.loans.reduce(function (s, l) { return s + l.amount; }, 0)) + ').', 'Wczytaj kopię', function () {
        try { localStorage.setItem(KEY + '_przed_wczytaniem', JSON.stringify(state)); } catch (e) { /* brak miejsca */ }
        state = next;
        state.loans.forEach(function (l) { fundsOf(l); });
        save();
        render();
        showDone('Kopia wczytana');
      });
    };
    reader.readAsText(file);
  }

  // ---------- Karty (Środki / Statystyki / Konto) ----------
  var TABS = { home: { view: el.viewHome, title: 'Środki' }, stats: { view: el.viewStats, title: 'Statystyki' }, account: { view: $('viewAccount'), title: 'Konto' } };
  function switchTab(name) {
    if (!TABS[name]) name = 'home';
    var stats = name === 'stats';
    Object.keys(TABS).forEach(function (k) { TABS[k].view.hidden = k !== name; });
    var view = TABS[name].view;
    view.classList.remove('is-entering'); void view.offsetWidth; view.classList.add('is-entering');
    el.tabbar.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === name); });
    el.navbarTitle.textContent = TABS[name].title;
    try { history.replaceState(null, '', name === 'home' ? location.pathname + location.search : '#' + name); } catch (e) { /* plik lokalny */ }
    window.scrollTo(0, 0);
    onScroll();
    if (!stats && addingCat) { addingCat = false; catDraft = ''; renderCustomCats(); }
    if (stats) { selDay = null; renderStats(); }
    try { window.dispatchEvent(new CustomEvent('saldo:tab', { detail: name })); } catch (e) { /* stara przeglądarka */ }
  }

  // ---------- Interfejs dla modułu bazy danych (sync.js) ----------
  function isEmptyState(s) {
    return !s || (!s.cash && !s.bank && !(s.loans && s.loans.length) && !(s.history && s.history.length) && !(s.customCats && s.customCats.length));
  }
  window.Saldo = {
    getState: function () { return state; },
    // Podmienia całe dane (np. z chmury albo z kopii). silent — bez odsyłania zmian z powrotem do chmury.
    replaceState: function (next, opts) {
      state = migrate(JSON.parse(JSON.stringify(next)));
      // Udziały pożyczek (gotówka/konto/bez zmian) zawsze liczone z historii — każde urządzenie dochodzi do tego samego wyniku
      state.loans.forEach(function (l) { l.funds = null; fundsOf(l); });
      save({ silent: !!(opts && opts.silent) });
      render();
    },
    migrate: function (s) { return migrate(JSON.parse(JSON.stringify(s))); },
    isEmpty: isEmptyState,
    money: money, plural: plural, when: when, esc: esc, icon: icon, ymd: ymd,
    fullDate: function (ts) { return fullFmt.format(new Date(ts)); },
    total: function (s) { s = s || state; return s.cash + s.bank + (s.loans || []).reduce(function (a, l) { return a + l.amount; }, 0); },
    toast: function (m, k) { toast(m, k); },
    showDone: function (m) { showDone(m); },
    actionChoices: function (t, b, onCancel) { actionChoices(t, b, onCancel); },
    setSyncActive: function (on) { syncActive = !!on; },
    confirmAction: function (t, b, cb) { confirmAction(t, b, cb); },
    guessCat: guessCat,
    openSheet: function (p) { openPanel(p); },
    closeSheet: function (p) { closePanel(p); },
    catName: function (id) { return catById(id).name; },
    // Wydatek dopisany automatycznie (np. płatność Apple Pay ze Skrótów). Zwraca false, gdy już istnieje.
    addExternalExpense: function (x) {
      if (!x || !x.id || findEntry(x.id) || !(x.amount > 0) || x.amount > MAX_GROSZE) return false;
      var key = x.source === 'cash' ? 'cash' : 'bank';
      var now = Date.now();
      var before = state[key];
      state[key] -= x.amount;
      state[key + 'At'] = now;
      var e = { id: x.id, source: key, mode: 'sub', cat: x.cat || 'other', before: before, after: state[key], at: x.at || now, note: String(x.note || '').slice(0, 60), via: x.via || '' };
      state.history.push(e);
      state.history.sort(function (a, b) { return b.at - a.at; });
      if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
      lastNewId = e.id;
      setTimeout(function () { if (lastNewId === e.id) lastNewId = null; }, 1500);
      save();
      render();
      return true;
    }
  };

  // ---------- Rozpoznawanie grupy po nazwie sklepu ----------
  // Najpierw uczy się z historii (grupa, którą ostatnio miał wydatek z tą samą notatką/sklepem),
  // a gdy brak — korzysta z listy znanych sklepów.
  var MERCHANT_RULES = [
    ['fuel', ['orlen', 'bp ', 'bp-', 'shell', 'circle k', 'circlek', 'moya', 'amic', 'lotos', 'stacja paliw', 'huzar', 'avia']],
    ['food', ['biedronka', 'lidl', 'kaufland', 'auchan', 'carrefour', 'zabka', 'dino', 'netto', 'aldi', 'stokrotka', 'lewiatan', 'spar', 'polomarket', 'intermarche', 'frisco', 'delikatesy', 'groszek', 'mila', 'chata polska', 'eurospar', 'piekarnia', 'warzywniak', 'market']],
    ['restaurants', ['mcdonald', 'kfc', 'burger king', 'starbucks', 'costa coffee', 'pizza', 'restaur', 'bistro', 'sushi', 'kebab', 'cafe', 'kawiarnia', 'wolt', 'glovo', 'pyszne', 'uber eats', 'ubereats', 'subway', 'north fish', 'bar ', 'pasibus', 'max premium']],
    ['transport', ['uber', 'bolt', 'freenow', 'free now', 'mpk', 'ztm', 'pkp', 'intercity', 'koleje', 'jakdojade', 'skycash', 'ryanair', 'wizz', 'lot polish', 'flixbus', 'parking', 'mobilet', 'autostrad', 'e-toll']],
    ['subs', ['netflix', 'spotify', 'youtube', 'hbo', 'max.com', 'disney', 'canal+', 'canal plus', 'prime video', 'amazon prime', 'icloud', 'apple.com', 'apple music', 'google one', 'chatgpt', 'openai', 'tidal', 'player.pl', 'polsat box']],
    ['health', ['apteka', 'doz', 'ziko', 'super-pharm', 'superpharm', 'medicover', 'luxmed', 'lux med', 'enel-med', 'lekarz', 'dentyst', 'stomatolog', 'przychodnia', 'optyk']],
    ['beauty', ['rossmann', 'hebe', 'sephora', 'douglas', 'notino', 'fryzjer', 'barber', 'kosmety']],
    ['clothes', ['zara', 'h&m', 'reserved', 'ccc', 'sinsay', 'house', 'cropp', 'mohito', 'pepco', 'nike', 'adidas', 'zalando', 'primark', 'bershka', 'pull&bear', 'stradivarius', 'tk maxx', 'answear', 'eobuwie', 'deichmann', 'half price']],
    ['electronics', ['media expert', 'mediaexpert', 'rtv euro', 'euro agd', 'x-kom', 'morele', 'media markt', 'mediamarkt', 'neonet', 'komputronik', 'apple store', 'istore', 'cortland']],
    ['home', ['ikea', 'castorama', 'leroy merlin', 'obi', 'jysk', 'action', 'bricomarche', 'agata meble', 'black red white', 'homla', 'jula', 'merkury']],
    ['fun', ['cinema city', 'multikino', 'helios', 'steam', 'playstation', 'xbox', 'nintendo', 'empik', 'ebilet', 'eventim', 'kino', 'teatr', 'bowling']],
    ['bills', ['pge', 'tauron', 'enea', 'energa', 'pgnig', 'orange', 'play', 'plus ', 't-mobile', 'tmobile', 'upc', 'vectra', 'netia', 'inea', 'czynsz', 'wodociag', 'gaz ']],
    ['pets', ['zooplus', 'kakadu', 'maxi zoo', 'maxizoo', 'weteryn', 'zoo ']],
    ['sport', ['decathlon', 'silownia', 'gym', 'benefit', 'zdrofit', 'mcfit', 'calypso', 'fitness', 'go sport', 'intersport', 'martes']],
    ['travel', ['booking', 'airbnb', 'hotel', 'hostel', 'expedia', 'trivago', 'itaka', 'rainbow', 'tui']],
    ['education', ['udemy', 'coursera', 'ksiegarnia', 'duolingo', 'szkola', 'kurs']],
    ['kids', ['smyk', 'toys', 'zabawk']],
    ['insurance', ['pzu', 'warta', 'allianz', 'ergo hestia', 'hestia', 'link4', 'generali', 'uniqa', 'compensa', 'ubezpiecz']],
    ['gifts', ['kwiaciarnia', 'kwiaty', 'prezent', 'apart', 'w.kruk', 'yes bizuteria', 'pandora']]
  ];
  function normText(s) {
    return ' ' + String(s || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim() + ' ';
  }
  function guessCat(merchant) {
    var m = normText(merchant);
    if (m.trim()) {
      // Nauka: ostatni wydatek z tym samym sklepem (notatką)
      for (var i = 0; i < state.history.length; i++) {
        var e = state.history[i];
        if (e.mode === 'sub' && e.source !== 'loan' && e.cat && normText(e.note) === m) return e.cat;
      }
      for (var r = 0; r < MERCHANT_RULES.length; r++) {
        var keys = MERCHANT_RULES[r][1];
        for (var k = 0; k < keys.length; k++) if (m.indexOf(keys[k]) !== -1 || m.indexOf(' ' + keys[k].trim() + ' ') !== -1) return MERCHANT_RULES[r][0];
      }
    }
    return 'other';
  }

  // ---------- Zdarzenia ----------
  document.addEventListener('touchstart', function () {}, { passive: true }); // :active na iOS

  document.querySelectorAll('[data-source]').forEach(function (b) {
    b.addEventListener('click', function () { openEdit({ type: 'source', key: b.getAttribute('data-source') }); });
  });
  el.loansRow.addEventListener('click', function () {
    if (state.loans.length) openPanel(el.loansSheet);
    else openEdit({ type: 'newLoan' });
  });
  el.loansClose.addEventListener('click', function () { closePanel(el.loansSheet); });
  function newLoanFromList() { openEdit({ type: 'newLoan' }); }
  el.loansAdd.addEventListener('click', newLoanFromList);
  el.loansAddBig.addEventListener('click', newLoanFromList);
  el.loanList.addEventListener('click', function (e) {
    var b = e.target.closest('[data-loan]');
    if (b) openPerson(b.getAttribute('data-loan'));
  });
  // Ekran osoby
  el.personBack.addEventListener('click', closePerson);
  el.personRepay.addEventListener('click', function () { openEdit({ type: 'loan', id: personId, mode: 'sub' }); });
  el.personLend.addEventListener('click', function () { openEdit({ type: 'loan', id: personId, mode: 'add' }); });
  el.personCorrect.addEventListener('click', function () { openEdit({ type: 'loan', id: personId, mode: 'set' }); });
  el.personDelete.addEventListener('click', function () { deleteLoan(personId); });
  el.personHistory.addEventListener('click', function (e) {
    var b = e.target.closest('[data-entry]');
    if (b) openEntry(b.getAttribute('data-entry'));
  });
  el.history.addEventListener('click', function (e) {
    if (e.target.closest('#histAll')) { openHistory(); return; }
    var b = e.target.closest('[data-entry]');
    if (b) openEntry(b.getAttribute('data-entry'));
  });

  el.modeControl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b && b.getAttribute('data-mode') !== mode) { setMode(b.getAttribute('data-mode'), true); el.amountInput.focus(); }
  });
  el.fundControl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-fund]');
    if (!b) return;
    fund = b.getAttribute('data-fund');
    setSegment(el.fundControl, 'data-fund', fund);
    updatePreview();
  });
  el.amountInput.addEventListener('input', function () { sanitizeInput(); el.sheetError.hidden = true; updatePreview(); });
  el.amountInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) commit(); } });
  el.nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.amountInput.focus(); } });
  el.nameInput.addEventListener('input', function () { el.sheetError.hidden = true; });
  el.noteInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) commit(); } });
  el.sheetSave.addEventListener('click', commit);
  el.sheetCancel.addEventListener('click', closeEdit);
  el.fillAllBtn.addEventListener('click', function () { el.amountInput.value = toInput(currentValue()); lastGoodAmount = el.amountInput.value; updatePreview(); });

  el.entryCancel.addEventListener('click', closeEntry);
  el.entrySave.addEventListener('click', saveEntry);
  el.entryNote.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) saveEntry(); } });
  el.entryDelete.addEventListener('click', deleteEntry);

  // Wybór grupy
  el.catPickBtn.addEventListener('click', function () {
    openCatPicker(selCat, function (id) { selCat = id; renderCatButton('catPick', id); });
  });
  el.entryCatPickBtn.addEventListener('click', function () {
    openCatPicker(entryCat, function (id) { entryCat = id; renderCatButton('entryCatPick', id); });
  });
  el.catCancel.addEventListener('click', function () { closePanel(el.catSheet); });
  el.catSearch.addEventListener('input', renderCatResults);
  el.catSearch.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;
    var q = el.catSearch.value.trim();
    if (!q) return;
    var hits = catMatches(q);
    if (hits.length) pickCat(hits[0].id); else createCatFromSearch();
  });
  el.catResults.addEventListener('click', function (e) {
    var b = e.target.closest('[data-pick]');
    if (b) { pickCat(b.getAttribute('data-pick')); return; }
    if (e.target.closest('[data-create]')) createCatFromSearch();
  });

  el.backdrop.addEventListener('click', function () { if (Date.now() - openedAt > 350) closeTop(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeTop(); });

  // Historia
  el.histClose.addEventListener('click', function () { closePanel(el.historySheet); });
  el.histPeriodBtn.addEventListener('click', choosePeriod);
  el.histType.addEventListener('click', function (e) {
    var b = e.target.closest('[data-htype]');
    if (!b) return;
    histFilter.type = b.getAttribute('data-htype');
    histLimit = 100;
    renderHistorySheet();
  });
  [el.histFrom, el.histTo].forEach(function (inp) {
    inp.addEventListener('change', function () {
      histFilter.from = el.histFrom.value;
      histFilter.to = el.histTo.value;
      renderHistorySheet();
    });
  });
  el.histList.addEventListener('click', function (e) {
    if (e.target.closest('#histMoreBtn')) { histLimit += 200; renderHistorySheet(); return; }
    var b = e.target.closest('[data-entry]');
    if (b) openEntry(b.getAttribute('data-entry'));
  });
  el.actionCancel.addEventListener('click', closeActions);

  // Statystyki
  el.tabbar.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tab]');
    if (t) switchTab(t.getAttribute('data-tab'));
  });
  el.monthPrev.addEventListener('click', function () { selMonth--; selDay = null; renderStats(); });
  el.monthNext.addEventListener('click', function () { syncNow(); if (selMonth < nowIdx) { selMonth++; selDay = null; renderStats(); } });
  el.savingsChart.addEventListener('click', function (e) {
    var r = e.target.closest('[data-m]');
    if (!r) return;
    selMonth = Number(r.getAttribute('data-m')); selDay = null; renderStats();
  });
  el.dailyChart.addEventListener('click', function (e) {
    var r = e.target.closest('[data-d]');
    if (!r) return;
    syncNow();
    var d = Number(r.getAttribute('data-d'));
    selDay = selDay === d ? null : d;
    var months = computeMonths();
    renderDailyChart(months[selMonth] || emptyMonth(), false);
  });
  el.addCatBtn.addEventListener('click', function () { addingCat = true; focusNewCat = true; renderCustomCats(); });
  el.customCats.addEventListener('click', function (e) {
    var b = e.target.closest('[data-del-cat]');
    if (!b) return;
    var id = b.getAttribute('data-del-cat');
    var c = catById(id);
    confirmAction('Usunąć grupę „' + c.name + '”? Wydatki z tej grupy trafią do grupy „Inne”.', 'Usuń grupę', function () {
      if (!state.customCats.some(function (x) { return x.id === id; })) return;
      state.customCats = state.customCats.filter(function (x) { return x.id !== id; });
      state.history.forEach(function (h) { if (h.cat === id) h.cat = 'other'; });
      save(); render(); toast('Grupa usunięta', 'delete');
    });
  });
  el.backupExport.addEventListener('click', exportBackup);
  el.backupImport.addEventListener('click', function () { el.backupFile.value = ''; el.backupFile.click(); });
  el.backupFile.addEventListener('change', function () { if (el.backupFile.files && el.backupFile.files[0]) importBackup(el.backupFile.files[0]); });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (el.viewStats.hidden) return;
      if (String(el.savingsChart.clientWidth) === el.savingsChart.dataset.w) return; // np. klawiatura — szerokość bez zmian
      renderStats();
    }, 150);
  });

  // Mały tytuł w pasku po przewinięciu dużego tytułu
  function onScroll() { el.navbar.classList.toggle('is-scrolled', window.scrollY > 36); }
  window.addEventListener('scroll', onScroll, { passive: true });

  // Odświeżaj czasy względne
  setInterval(function () {
    if (anyOpen() || document.hidden) return;
    renderHome();
    if (!addingCat) renderStatsIfVisible(); // nie przerywaj wpisywania nazwy nowej grupy
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || anyOpen()) return;
    // Nie nadpisuj niezapisanych zmian danymi z pamięci; przy synchronizacji stan trzyma moduł bazy
    if (!dirty && !syncActive) state = load();
    state.loans.forEach(function (l) { fundsOf(l); });
    render();
  });

  // Poproś przeglądarkę, by nie usuwała danych przy braku miejsca
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* brak */ }

  state.loans.forEach(function (l) { fundsOf(l); });
  paintIcons();
  renderHome();
  switchTab((location.hash || '').replace('#', '') || 'home');
  if (loadWarning) toast(loadWarning, 'info');

  // ---------- Service Worker ----------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
