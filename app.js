/* Saldo — kontrola środków (gotówka, konto, pożyczone, grupy wydatków, statystyki).
   Dane w localStorage (klucz saldo_v1), kwoty w groszach. */
(function () {
  'use strict';

  var icon = SaldoIcons.icon;
  var DEFAULT_CATS = SaldoIcons.DEFAULT_CATS;
  var CUSTOM_COLORS = SaldoIcons.CUSTOM_COLORS;

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

  function defaultState() {
    return { cash: 0, bank: 0, cashAt: null, bankAt: null, loans: [], loansAt: null, lastFund: 'cash', history: [], customCats: [] };
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      var s = JSON.parse(raw);
      var d = defaultState();
      for (var k in d) if (!(k in s)) s[k] = d[k];
      delete s.privacy;
      return s;
    } catch (e) { return defaultState(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* brak miejsca / tryb prywatny */ }
  }
  var state = load();

  function loansTotal() { return state.loans.reduce(function (s, l) { return s + l.amount; }, 0); }
  function findLoan(id) { for (var i = 0; i < state.loans.length; i++) if (state.loans[i].id === id) return state.loans[i]; return null; }
  function findEntry(id) { for (var i = 0; i < state.history.length; i++) if (state.history[i].id === id) return state.history[i]; return null; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function other(key) { return key === 'cash' ? 'bank' : 'cash'; }

  // ---------- Grupy wydatków ----------
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
  function sortedCats() {
    var u = catUsage();
    var list = allCats().map(function (c, i) { return { c: c, i: i }; });
    list.sort(function (a, b) {
      var ao = a.c.id === 'other', bo = b.c.id === 'other';
      if (ao !== bo) return ao ? 1 : -1; // „Inne” zawsze na końcu
      return (u[b.c.id] || 0) - (u[a.c.id] || 0) || a.i - b.i;
    });
    return list.map(function (x) { return x.c; });
  }
  function addCustomCat(name) {
    name = name.trim().replace(/\s+/g, ' ');
    if (!name) return null;
    var exists = allCats().filter(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })[0];
    if (exists) return exists;
    var c = { id: 'c_' + uid(), name: name, icon: 'tag', color: CUSTOM_COLORS[state.customCats.length % CUSTOM_COLORS.length] };
    state.customCats.push(c);
    save();
    return c;
  }

  // Wiersz „Grupa wydatku” (w arkuszu kwoty i w szczegółach wpisu)
  function renderCatButton(prefix, id) {
    var iconEl = document.getElementById(prefix + 'Icon');
    var nameEl = document.getElementById(prefix + 'Name');
    if (!id) {
      iconEl.style.background = 'var(--gray)';
      iconEl.innerHTML = icon('tag');
      nameEl.textContent = 'Wybierz grupę';
      nameEl.classList.add('is-placeholder');
      return;
    }
    var c = catById(id);
    iconEl.style.background = c.color;
    iconEl.innerHTML = icon(c.icon);
    nameEl.textContent = c.name;
    nameEl.classList.remove('is-placeholder');
  }

  // Arkusz wyboru grupy z wyszukiwarką
  var catPick = null; // { selected, onPick }
  function norm(s) {
    return String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function byName(a, b) {
    if (a.id === 'other') return 1;
    if (b.id === 'other') return -1;
    return a.name.localeCompare(b.name, 'pl');
  }
  function catRow(c, sel) {
    return '<li><button class="row cat-row" data-pick="' + esc(c.id) + '">' +
      '<span class="row-icon cat-icon" style="background:' + c.color + '">' + icon(c.icon) + '</span>' +
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
    var sel = catPick.selected;
    var html = '';
    if (!q) {
      var u = catUsage();
      var top = allCats().filter(function (c) { return u[c.id]; }).sort(function (a, b) { return u[b.id] - u[a.id]; }).slice(0, 5);
      if (top.length) html += '<h2 class="section-header">Najczęściej używane</h2><ul class="group group--sheet">' + top.map(function (c) { return catRow(c, sel); }).join('') + '</ul>';
      html += '<h2 class="section-header">Wszystkie grupy</h2><ul class="group group--sheet">' +
        allCats().slice().sort(byName).map(function (c) { return catRow(c, sel); }).join('') + '</ul>';
    } else {
      var hits = catMatches(q);
      var exact = allCats().some(function (c) { return norm(c.name) === norm(q); });
      html += '<ul class="group group--sheet">' + hits.map(function (c) { return catRow(c, sel); }).join('');
      if (!exact) {
        html += '<li><button class="row cat-row" data-create><span class="row-icon row-icon--blue">' + icon('plus') + '</span>' +
          '<span class="row-body"><span class="row-title">Dodaj grupę „' + esc(q) + '”</span><span class="row-sub">Nowa własna grupa</span></span></button></li>';
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
    el.catSearch.blur();
    if (catPick) catPick.onPick(id);
    closePanel(el.catSheet);
  }
  function createCatFromSearch() {
    var c = addCustomCat(el.catSearch.value);
    if (!c) return;
    pickCat(c.id);
    renderStatsIfVisible();
    toast('Dodano grupę: ' + c.name);
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
    return isFinite(n) ? n : NaN;
  }
  function plural(n, one, few, many) {
    if (n === 1) return '1 ' + one;
    var d = n % 10, h = n % 100;
    return n + ' ' + (d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many);
  }
  function initials(name) {
    var w = name.trim().split(/\s+/);
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
    history: $('history'), historyEmpty: $('historyEmpty'),
    historySheet: $('historySheet'), histClose: $('histClose'), histPeriodBtn: $('histPeriodBtn'), histPeriodName: $('histPeriodName'),
    histCustom: $('histCustom'), histFrom: $('histFrom'), histTo: $('histTo'), histType: $('histType'),
    histSummary: $('histSummary'), histList: $('histList'), histEmpty: $('histEmpty'),
    backdrop: $('backdrop'),
    sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetCancel: $('sheetCancel'), sheetSave: $('sheetSave'),
    modeControl: $('modeControl'), nameGroup: $('nameGroup'), nameInput: $('nameInput'),
    sheetCurrentLabel: $('sheetCurrentLabel'), sheetCurrent: $('sheetCurrent'),
    amountInput: $('amountInput'), amountSign: $('amountSign'),
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
    actionSheet: $('actionSheet'), actionTitle: $('actionTitle'), actionGroup: $('actionGroup'), actionCancel: $('actionCancel'),
    toast: $('toast'), toastText: $('toastText')
  };

  // ---------- Render: Środki ----------

  function render() {
    renderHome();
    renderStatsIfVisible();
  }

  function renderHome() {
    var lt = loansTotal();
    var total = state.cash + state.bank + lt;
    el.today.textContent = dayFmt.format(new Date());

    el.totalAmount.textContent = money(total);
    el.totalAmount.classList.toggle('is-long', Math.abs(total) >= 10000000);
    var last = Math.max(state.cashAt || 0, state.bankAt || 0, state.loansAt || 0);
    el.totalUpdated.textContent = last ? 'Aktualizacja: ' + when(last).toLowerCase() : '';

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

    el.cashAmount.textContent = money(state.cash);
    el.bankAmount.textContent = money(state.bank);
    el.loansAmount.textContent = money(lt);
    el.cashAmount.style.color = state.cash < 0 ? 'var(--red)' : '';
    el.bankAmount.style.color = state.bank < 0 ? 'var(--red)' : '';
    el.cashUpdated.textContent = state.cashAt ? when(state.cashAt) : 'Stuknij, aby ustawić';
    el.bankUpdated.textContent = state.bankAt ? when(state.bankAt) : 'Stuknij, aby ustawić';
    el.loansSub.textContent = state.loans.length ? plural(state.loans.length, 'osoba', 'osoby', 'osób') : 'Stuknij, aby dodać';

    renderHistory();
    renderLoans();
    renderPerson();
  }

  function renderLoans() {
    el.loansTotal.textContent = money(loansTotal());
    el.loansEmpty.hidden = state.loans.length > 0;
    var sorted = state.loans.slice().sort(function (a, b) { return b.amount - a.amount; });
    el.loanList.innerHTML = sorted.map(function (l) {
      return '<li><button class="row" data-loan="' + esc(l.id) + '">' +
        '<span class="avatar">' + esc(initials(l.name)) + '</span>' +
        '<span class="row-body"><span class="row-title">' + esc(l.name) + '</span>' +
        '<span class="row-sub">Od ' + esc(dateFmt.format(new Date(l.since))) + (l.note ? ' · ' + esc(l.note) : '') + '</span></span>' +
        '<span class="row-value amount">' + money(l.amount) + '</span>' +
        '<span class="row-chevron ic">' + icon('chevronRight') + '</span>' +
        '</button></li>';
    }).join('');
  }

  var FUND_FROM = { cash: ' z gotówki', bank: ' z konta', none: '' };
  var FUND_TO = { cash: ' do gotówki', bank: ' na konto', none: '' };

  // Wygląd wpisu historii: ikona, kolor, tytuł, opis, kwota
  function describe(e) {
    var d = { delta: e.after - e.before, bg: '', cls: 'row-icon--gray', ic: 'equal', title: '', sub: '', deltaCls: 'neu' };
    if (e.source === 'loan') {
      var f = e.fund || 'none';
      if (e.mode === 'add') { d.ic = 'handCoins'; d.cls = 'row-icon--orange'; d.sub = 'Pożyczka' + FUND_FROM[f]; }
      else if (e.mode === 'sub') { d.ic = 'undo'; d.cls = 'row-icon--green'; d.sub = (e.after === 0 ? 'Spłata całości' : 'Spłata') + FUND_TO[f]; }
      else if (e.mode === 'del') { d.ic = 'trash'; d.cls = 'row-icon--gray'; d.sub = f !== 'none' ? 'Cofnięto pożyczkę, zwrot' + FUND_TO[f] : 'Usunięto pożyczkę'; }
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
      d.sub = (e.note ? c.name + ' · ' : '') + src;
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
  function iconBadge(d, extraCls) {
    return '<span class="' + (extraCls || 'row-icon') + ' ' + d.cls + '"' + (d.bg ? ' style="background:' + d.bg + '"' : '') + '>' + icon(d.ic) + '</span>';
  }

  // Jeden wiersz historii; timeOnly = w widoku dni pokazuj samą godzinę
  function histRow(e, timeOnly) {
    var d = describe(e);
    var deltaTxt = e.mode === 'move' ? money(d.delta) : signed(d.delta);
    var t = timeOnly ? timeFmt.format(new Date(e.at)) : when(e.at);
    return '<li><button class="row hist-row" data-entry="' + esc(e.id) + '">' + iconBadge(d) +
      '<span class="row-body"><span class="row-title">' + esc(d.title) + '</span><span class="row-sub">' + esc(d.sub + ' · ' + t) + '</span></span>' +
      '<span class="hist-right"><span class="hist-delta amount ' + d.deltaCls + '">' + deltaTxt + '</span>' +
      '<span class="hist-after amount">' + money(e.after) + '</span></span></button></li>';
  }

  var HOME_HISTORY = 5;
  function renderHistory() {
    var h = state.history;
    el.historyEmpty.hidden = h.length > 0;
    el.history.hidden = h.length === 0;
    $('historyHint').hidden = h.length === 0;
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
        var a = f ? f.getTime() : 0;
        var b = t ? new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() : INF;
        return a <= b ? [a, b] : [b, a];
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

  function renderHistorySheet() {
    if (!isOpen(el.historySheet)) return;
    var p = HIST_PERIODS.filter(function (x) { return x.id === histFilter.period; })[0];
    el.histPeriodName.textContent = p.name;
    el.histCustom.hidden = histFilter.period !== 'custom';
    setSegment(el.histType, 'data-htype', histFilter.type);

    var r = periodRange();
    var list = state.history.filter(function (e) { return e.at >= r[0] && e.at < r[1] && matchesType(e); });
    var exp = 0, inc = 0;
    list.forEach(function (e) {
      if (e.source === 'loan') return;
      if (e.mode === 'sub') exp += e.before - e.after;
      if (e.mode === 'add') inc += e.after - e.before;
    });
    var parts = [plural(list.length, 'wpis', 'wpisy', 'wpisów')];
    if (inc) parts.push('wpływy <b>' + money(inc) + '</b>');
    if (exp) parts.push('wydatki <b>' + money(exp) + '</b>');
    el.histSummary.innerHTML = parts.join(' · ');

    var html = '', curDay = null, dayItems = [], dayExp = 0, shown = 0;
    var flush = function () {
      if (curDay === null) return;
      html += '<div class="day-header"><span>' + esc(dayLabel(curDay)) + '</span>' + (dayExp ? '<span class="amount">' + money(-dayExp) + '</span>' : '') + '</div>' +
        '<ul class="group group--sheet">' + dayItems.join('') + '</ul>';
    };
    for (var i = 0; i < list.length && shown < histLimit; i++, shown++) {
      var e = list[i];
      var k = startOfDay(e.at);
      if (k !== curDay) { flush(); curDay = k; dayItems = []; dayExp = 0; }
      dayItems.push(histRow(e, true));
      if (e.source !== 'loan' && e.mode === 'sub') dayExp += e.before - e.after;
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
    el.historySheet.querySelector('.person-scroll').scrollTop = 0;
  }

  function choosePeriod() {
    actionChoices('Pokaż wpisy z okresu', HIST_PERIODS.map(function (p) {
      return {
        text: p.name, bold: p.id === histFilter.period,
        cb: function () {
          histFilter.period = p.id;
          if (p.id === 'custom' && !histFilter.from) {
            var n = new Date();
            histFilter.from = ymd(new Date(n.getFullYear(), n.getMonth(), 1));
            histFilter.to = ymd(n);
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

  function computeMonths() {
    var m = {};
    state.history.forEach(function (e) {
      if (e.source === 'loan' || (e.mode !== 'add' && e.mode !== 'sub')) return;
      var i = monthIdx(e.at);
      var x = m[i] || (m[i] = { inc: 0, exp: 0, byCat: {}, catCount: {}, days: {}, dayCount: {}, n: 0 });
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

  function renderStats() {
    nowIdx = monthIdx(Date.now());
    if (selMonth > nowIdx) selMonth = nowIdx;
    var months = computeMonths();
    var keys = Object.keys(months).map(Number);
    var firstIdx = keys.length ? Math.min.apply(null, keys) : nowIdx;
    var cur = months[selMonth] || emptyMonth();
    var mi = idxMonth(selMonth);

    el.monthLabel.textContent = MONTHS[mi] + ' ' + idxYear(selMonth);
    el.monthPrev.disabled = selMonth <= Math.min(firstIdx, nowIdx - 1);
    el.monthNext.disabled = selMonth >= nowIdx;

    var s = cur.inc - cur.exp;
    el.savingsLabel.textContent = (s < 0 ? 'Na minusie w ' : 'Odłożone w ') + MONTHS_IN[mi];
    el.savingsAmount.textContent = signed(s);
    if (!cur.n) el.savingsRate.innerHTML = 'Brak wpływów i wydatków w tym miesiącu.';
    else if (s >= 0 && cur.inc > 0) el.savingsRate.innerHTML = 'To <b>' + Math.round(s / cur.inc * 100) + '%</b> wpływów z tego miesiąca.';
    else if (s < 0) el.savingsRate.innerHTML = 'Wydatki były wyższe od wpływów o <b>' + money(-s) + '</b>.';
    else el.savingsRate.innerHTML = 'Brak wpływów w tym miesiącu.';
    el.incomeAmount.textContent = money(cur.inc);
    el.expenseAmount.textContent = money(cur.exp);

    renderSavingsChart(months);
    renderCatStats(cur);
    renderDailyChart(cur);
    renderCustomCats();
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  // Słupek z zaokrąglonym końcem (4px) od strony wartości, płaski przy osi
  function barPath(x, w, y0, y1) {
    var h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    var r = Math.min(4, w / 2, h);
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

  function renderSavingsChart(months) {
    var N = 6;
    var end = selMonth > nowIdx - N ? nowIdx : selMonth;
    var idxs = [];
    for (var i = end - N + 1; i <= end; i++) idxs.push(i);
    var vals = idxs.map(function (i) { var m = months[i]; return m ? m.inc - m.exp : 0; });

    var W = Math.max(260, Math.round(el.savingsChart.clientWidth || 320));
    var H = 180, top = 24, bottom = 26;
    var plotH = H - top - bottom;
    var maxPos = Math.max(0, Math.max.apply(null, vals));
    var maxNeg = Math.max(0, -Math.min.apply(null, vals));
    var span = maxPos + maxNeg;
    var y0 = span ? top + plotH * (maxPos / span) : top + plotH;
    var k = span ? plotH / span : 0;
    // gdy są tylko wartości ujemne, zostaw miejsce na etykietę pod słupkiem
    if (!maxPos && maxNeg) { y0 = top; k = (plotH - 4) / span; }

    var sw = W / N;
    var bw = Math.min(30, sw * 0.5);
    var out = svgEl(W, H, 'Odłożone pieniądze w ostatnich miesiącach');
    out += '<line class="ch-axis" x1="0" x2="' + W + '" y1="' + y0 + '" y2="' + y0 + '"/>';
    idxs.forEach(function (mIdx, j) {
      var v = vals[j];
      var cx = sw * j + sw / 2;
      var x = cx - bw / 2;
      var y1 = y0 - v * k;
      var sel = mIdx === selMonth;
      var p = barPath(x, bw, y0, y1);
      if (p) out += '<path class="' + (v >= 0 ? 'ch-pos' : 'ch-neg') + (sel ? '' : ' ch-dim') + '" d="' + p + '"/>';
      out += '<text class="ch-tick' + (sel ? ' is-sel' : '') + '" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + MONTHS_SHORT[idxMonth(mIdx)] + '</text>';
      if (sel && (months[mIdx])) {
        var ly = v >= 0 ? y1 - 7 : y1 + 15;
        var anchor = j === 0 ? 'start' : j === N - 1 ? 'end' : 'middle';
        var lx = j === 0 ? x : j === N - 1 ? x + bw : cx;
        out += '<text class="ch-val" x="' + lx + '" y="' + ly + '" text-anchor="' + anchor + '">' + moneyShort(v) + '</text>';
      }
      out += '<rect class="ch-hit" data-m="' + mIdx + '" x="' + (sw * j) + '" y="0" width="' + sw + '" height="' + H + '"><title>' +
        MONTHS[idxMonth(mIdx)] + ': ' + signed(v) + '</title></rect>';
    });
    out += '</svg>';
    el.savingsChart.innerHTML = out;

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

  function renderCatStats(cur) {
    var rows = Object.keys(cur.byCat).map(function (id) { return { c: catById(id), v: cur.byCat[id], n: cur.catCount[id] }; })
      .sort(function (a, b) { return b.v - a.v; });
    el.catStatsEmpty.hidden = rows.length > 0;
    el.catStats.hidden = rows.length === 0;
    if (!rows.length) { el.catStats.innerHTML = ''; return; }
    var max = rows[0].v;
    el.catStats.innerHTML = rows.map(function (r) {
      var share = cur.exp ? Math.round(r.v / cur.exp * 100) : 0;
      return '<li><div class="row cat-stat">' +
        '<span class="row-icon cat-icon" style="background:' + r.c.color + '">' + icon(r.c.icon) + '</span>' +
        '<span class="row-body">' +
          '<span class="cat-stat-top"><span class="row-title">' + esc(r.c.name) + '</span><span class="cat-stat-amount">' + money(r.v) + '</span></span>' +
          '<span class="cat-stat-bottom"><span class="meter"><span style="width:' + Math.max(2, r.v / max * 100).toFixed(1) + '%"></span></span>' +
          '<span class="cat-stat-pct">' + share + '%</span></span>' +
          '<span class="cat-stat-count">' + plural(r.n, 'wydatek', 'wydatki', 'wydatków') + '</span>' +
        '</span></div></li>';
    }).join('');
  }

  function renderDailyChart(cur) {
    var y = idxYear(selMonth), m = idxMonth(selMonth);
    var days = new Date(y, m + 1, 0).getDate();
    var elapsed = selMonth === nowIdx ? new Date().getDate() : days;
    var vals = [];
    for (var d = 1; d <= days; d++) vals.push(cur.days[d] || 0);
    var max = Math.max.apply(null, vals);

    var W = Math.max(260, Math.round(el.dailyChart.clientWidth || 320));
    var H = 130, top = 14, bottom = 22;
    var plotH = H - top - bottom;
    var y0 = top + plotH;
    var k = max ? plotH / max : 0;
    var sw = W / days;
    var bw = Math.max(2, Math.min(10, sw * 0.62));

    var out = svgEl(W, H, 'Wydatki w kolejnych dniach miesiąca');
    if (max) {
      out += '<line class="ch-grid" x1="0" x2="' + W + '" y1="' + top + '" y2="' + top + '"/>';
      out += '<text class="ch-tick" x="' + W + '" y="' + (top - 4) + '" text-anchor="end">' + moneyShort(max).replace('+', '') + '</text>';
    }
    out += '<line class="ch-axis" x1="0" x2="' + W + '" y1="' + y0 + '" y2="' + y0 + '"/>';
    vals.forEach(function (v, j) {
      var day = j + 1;
      var cx = sw * j + sw / 2;
      var p = barPath(cx - bw / 2, bw, y0, y0 - v * k);
      var dim = selDay && selDay !== day;
      if (p) out += '<path class="ch-pos' + (dim ? ' ch-dim' : '') + '" d="' + p + '"/>';
      if (day === 1 || day % 7 === 1 || day === days) {
        if (!(day === days && days - (Math.floor((days - 1) / 7) * 7 + 1) < 3 && day !== 1)) {
          out += '<text class="ch-tick' + (selDay === day ? ' is-sel' : '') + '" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + day + '</text>';
        }
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

  var addingCat = false;
  function renderCustomCats() {
    var u = catUsage();
    var rows = state.customCats.map(function (c) {
      var n = u[c.id] || 0;
      return '<li><div class="row">' +
        '<span class="row-icon cat-icon" style="background:' + c.color + '">' + icon(c.icon) + '</span>' +
        '<span class="row-body"><span class="row-title">' + esc(c.name) + '</span><span class="row-sub">' + (n ? plural(n, 'wydatek', 'wydatki', 'wydatków') : 'Brak wydatków') + '</span></span>' +
        '<button class="row-del" data-del-cat="' + esc(c.id) + '" aria-label="Usuń grupę ' + esc(c.name) + '">' + icon('trash') + '</button>' +
        '</div></li>';
    });
    if (addingCat) {
      rows.push('<li class="row row--input"><span class="row-icon row-icon--blue">' + icon('tag') + '</span>' +
        '<input id="newCatInput" type="text" maxlength="24" placeholder="Nazwa nowej grupy" enterkeyhint="done">' +
        '<button class="text-btn text-btn--bold" id="newCatSave">Dodaj</button></li>');
    }
    el.customCats.innerHTML = rows.join('');
    el.customCats.hidden = rows.length === 0;
    el.customCatsHint.hidden = state.customCats.length > 0;
    if (addingCat) {
      var inp = $('newCatInput');
      var done = function () {
        if (!inp.value.trim()) { inp.focus(); return; }
        var c = addCustomCat(inp.value);
        addingCat = false;
        renderCustomCats();
        toast('Dodano grupę: ' + c.name);
      };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); done(); } });
      $('newCatSave').addEventListener('click', done);
      inp.focus();
    }
  }

  // ---------- Arkusze (wspólne) ----------
  var PANELS = [el.sheet, el.loansSheet, el.personSheet, el.historySheet, el.entrySheet, el.catSheet, el.actionSheet];
  // Stan „otwarty” trzymamy w data-open (ustawiany od razu), a klasę is-open dokładamy w klatce animacji
  // tylko jeśli panel nadal ma być otwarty — szybkie „otwórz i zamknij” nie zostawi otwartego arkusza.
  function isOpen(panel) { return panel.dataset.open === '1'; }
  function anyOpen() { return PANELS.some(isOpen); }
  function openPanel(panel) {
    panel.dataset.open = '1';
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
    panel.dataset.open = '0';
    panel.classList.remove('is-open');
    panel.style.transform = '';
    if (!anyOpen()) {
      el.backdrop.classList.remove('is-open');
      document.body.classList.remove('no-scroll');
    }
    setTimeout(function () {
      if (!isOpen(panel)) panel.hidden = true;
      if (!anyOpen()) el.backdrop.hidden = true;
    }, 380);
  }

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
  // ctx: { type: 'source', key } | { type: 'loan', id } | { type: 'newLoan' }
  var ctx = null;
  var mode = 'set';
  var fund = 'cash';
  var selCat = null;

  var MODE_LABELS = {
    source: { set: 'Ustaw', add: 'Dodaj', sub: 'Odejmij', move: 'Przenieś' },
    loan: { set: 'Popraw kwotę', add: 'Pożycz więcej', sub: 'Spłata', move: '' }
  };

  function currentValue() {
    if (ctx.type === 'source') return state[ctx.key];
    if (ctx.type === 'loan') { var l = findLoan(ctx.id); return l ? l.amount : 0; }
    return 0;
  }

  function openEdit(c) {
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

    openPanel(el.sheet);
    // iOS pokaże klawiaturę tylko przy focus w obrębie gestu użytkownika
    (c.type === 'newLoan' ? el.nameInput : el.amountInput).focus({ preventScroll: true });
  }

  function closeEdit() {
    el.amountInput.blur(); el.noteInput.blur(); el.nameInput.blur();
    closePanel(el.sheet);
  }

  // ---------- Ekran osoby (pożyczka) ----------
  var personId = null;

  function openPerson(id) {
    personId = id;
    renderPerson();
    el.personSheet.querySelector('.person-scroll').scrollTop = 0;
    openPanel(el.personSheet);
  }
  function closePerson() { personId = null; closePanel(el.personSheet); }

  function renderPerson() {
    if (!personId) return;
    var l = findLoan(personId);
    if (!l) { if (isOpen(el.personSheet)) closePerson(); return; }
    var f = loanFund(l);
    el.personTitle.textContent = l.name;
    el.personAvatar.textContent = initials(l.name);
    el.personAmount.textContent = money(l.amount);
    el.personMeta.textContent = 'Pożyczone od ' + dayLongFmt.format(new Date(l.since)) + (f === 'cash' ? ' · z gotówki' : f === 'bank' ? ' · z konta' : '');
    var key = l.name.toLowerCase();
    var entries = state.history.filter(function (e) { return e.source === 'loan' && String(e.name).toLowerCase() === key; });
    el.personHistory.innerHTML = entries.map(function (e) {
      var d = describe(e);
      return '<li><button class="row hist-row" data-entry="' + esc(e.id) + '">' + iconBadge(d) +
        '<span class="row-body"><span class="row-title">' + esc(d.sub) + '</span><span class="row-sub">' + esc((e.note ? e.note + ' · ' : '') + when(e.at)) + '</span></span>' +
        '<span class="hist-right"><span class="hist-delta amount loan">' + signed(d.delta) + '</span><span class="hist-after amount">' + money(e.after) + '</span></span>' +
        '</button></li>';
    }).join('');
    el.personHistory.hidden = entries.length === 0;
  }

  function setMode(m, resetValue) {
    mode = m;
    setSegment(el.modeControl, 'data-mode', m);
    var sign = { add: '+', sub: '−', set: '', move: '' }[m];
    el.amountSign.textContent = ctx.type === 'source' ? sign : '';
    el.amountSign.className = 'amount-sign' + (m === 'add' ? ' pos' : m === 'sub' ? ' neg' : '');
    if (resetValue) {
      var setPrefill = m === 'set' && (ctx.type === 'loan' || (ctx.type === 'source' && state[ctx.key + 'At']));
      el.amountInput.value = setPrefill ? toInput(currentValue()) : '';
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
    var v = parseAmount(el.amountInput.value);
    var n = computeNew();
    var valid = n !== null && !(mode !== 'set' && v === 0) && !(ctx.type === 'loan' && n < 0);
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

  function sanitizeInput() {
    var v = el.amountInput.value.replace(/\./g, ',').replace(/[^\d,]/g, '');
    var i = v.indexOf(',');
    if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/,/g, '').slice(0, 2);
    if (v.length > 1 && v[0] === '0' && v[1] !== ',') v = v.replace(/^0+/, '') || '0';
    if (v.replace(',', '').length > 11) v = v.slice(0, -1);
    if (v !== el.amountInput.value) el.amountInput.value = v;
  }

  function applyFund(f, delta, now) {
    if (f !== 'cash' && f !== 'bank') return;
    state[f] += delta;
    state[f + 'At'] = now;
  }

  function pushHistory(entry) {
    entry.id = uid();
    state.history.unshift(entry);
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  }

  function commit() {
    var v = parseAmount(el.amountInput.value);
    var n = computeNew();
    var note = el.noteInput.value.trim();
    var now = Date.now();
    var msg;

    if (ctx.type === 'newLoan') {
      var name = el.nameInput.value.trim().replace(/\s+/g, ' ');
      if (!name) { showError('Wpisz, komu pożyczasz.'); el.nameInput.focus(); return; }
      if (isNaN(v) || v <= 0) { showError('Wpisz kwotę większą od zera.'); return; }
      var loan = state.loans.filter(function (l) { return l.name.toLowerCase() === name.toLowerCase(); })[0];
      if (!loan) { loan = { id: uid(), name: name, amount: 0, since: now, note: '', fund: fund }; state.loans.push(loan); }
      var before = loan.amount;
      loan.amount += v;
      loan.at = now;
      if (note) loan.note = note;
      applyFund(fund, -v, now);
      state.lastFund = fund;
      state.loansAt = now;
      pushHistory({ source: 'loan', name: loan.name, mode: 'add', fund: fund, before: before, after: loan.amount, at: now, note: note });
      msg = 'Pożyczka zapisana';
    } else if (ctx.type === 'loan') {
      var l = findLoan(ctx.id);
      if (n === null) { showError('Wpisz poprawną kwotę.'); return; }
      if (mode !== 'set' && v === 0) { showError('Kwota musi być większa od zera.'); return; }
      if (n < 0) { showError('Spłata nie może być większa niż pożyczka (' + money(l.amount) + ').'); return; }
      var b = l.amount;
      if (mode === 'add') applyFund(fund, -v, now);
      if (mode === 'sub') applyFund(fund, v, now);
      if (mode !== 'set') state.lastFund = fund;
      l.amount = n;
      l.at = now;
      state.loansAt = now;
      pushHistory({ source: 'loan', name: l.name, mode: mode, fund: mode === 'set' ? 'none' : fund, before: b, after: n, at: now, note: note });
      if (n === 0) {
        state.loans = state.loans.filter(function (x) { return x.id !== l.id; });
        msg = l.name + ': rozliczone';
      } else {
        msg = mode === 'sub' ? 'Spłata zapisana' : 'Zapisano';
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
        msg = mode === 'sub' ? catById(entry.cat).name + ': ' + money(v) : SOURCES[key].name + ': zapisano';
      }
    }
    save();
    render();
    closeEdit();
    toast(msg);
  }

  function showError(msg) {
    el.sheetError.textContent = msg;
    el.sheetError.hidden = false;
  }

  // Skąd wyszły pieniądze na pożyczkę (gotówka / konto / bez zmian)
  function loanFund(l) {
    if (l.fund) return l.fund;
    for (var i = 0; i < state.history.length; i++) {
      var e = state.history[i];
      if (e.source === 'loan' && e.mode === 'add' && e.name.toLowerCase() === l.name.toLowerCase()) return e.fund || 'none';
    }
    return 'none';
  }

  function deleteLoan(id) {
    var l = findLoan(id);
    if (!l) return;
    var f = loanFund(l);
    var remove = function (back) {
      var now = Date.now();
      if (back) applyFund(back, l.amount, now);
      state.loans = state.loans.filter(function (x) { return x.id !== l.id; });
      state.loansAt = now;
      pushHistory({ source: 'loan', name: l.name, mode: 'del', fund: back || 'none', before: l.amount, after: 0, at: now, note: '' });
      save();
      render();
      if (isOpen(el.personSheet)) closePerson();
      toast(back ? 'Pożyczka cofnięta' : 'Pożyczka usunięta');
    };
    if (f === 'cash' || f === 'bank') {
      actionChoices('Usunąć pożyczkę: ' + l.name + ' (' + money(l.amount) + ')? Pieniądze wyszły ' + FUND_FROM[f].trim() +
        '. Możesz je tam oddać, jakby pożyczki nie było, albo spisać na straty (łączna suma zmniejszy się).', [
        { text: 'Oddaj ' + money(l.amount) + FUND_TO[f], cb: function () { remove(f); } },
        { text: 'Spisz na straty', danger: true, cb: function () { remove(null); } }
      ]);
    } else {
      confirmAction('Usunąć pożyczkę: ' + l.name + ' (' + money(l.amount) + ')? Była zapisana bez zmiany gotówki i konta, więc łączna suma zmniejszy się o tę kwotę.', 'Usuń pożyczkę', function () { remove(null); });
    }
  }

  // ---------- Arkusz szczegółów wpisu ----------
  var entryId = null;
  var entryCat = null;

  function openEntry(id) {
    var e = findEntry(id);
    if (!e) return;
    entryId = id;
    var d = describe(e);
    el.entryIcon.className = 'entry-icon ' + d.cls;
    el.entryIcon.style.background = d.bg || '';
    el.entryIcon.innerHTML = icon(d.ic);
    el.entryAmount.textContent = e.mode === 'move' ? money(e.amount) : signed(d.delta);
    el.entryMeta.textContent = d.sub + ' · ' + fullFmt.format(new Date(e.at));
    el.entryNote.value = e.note || '';
    var isExpense = e.source !== 'loan' && e.mode === 'sub';
    el.entryCatBlock.hidden = !isExpense;
    entryCat = e.cat || 'other';
    if (isExpense) renderCatButton('entryCatPick', entryCat);

    var hint, blocked = false;
    if (e.source === 'loan') {
      var r = loanRevert(e);
      if (r.next < 0) {
        blocked = true;
        hint = 'Nie można usunąć: ' + e.name + ' ma teraz do oddania ' + money(r.cur) + ', a ten wpis dotyczy ' + money(Math.abs(r.d)) + '. Usuń najpierw nowsze wpisy tej osoby.';
      } else {
        hint = 'Usunięcie cofnie ten wpis. Pożyczka (' + e.name + '): ' + money(r.cur) + ' → ' + money(r.next) + '. ' +
          (r.fund ? SOURCES[r.fund].short + ': ' + money(state[r.fund]) + ' → ' + money(state[r.fund] + r.d) + '.' : 'Łączna suma zmieni się o ' + signed(-r.d) + '.');
      }
    } else {
      var src = SOURCES[e.source].short;
      var amt = Math.abs(e.after - e.before);
      hint = 'Usunięcie cofnie ten wpis: ' + ({
        add: src + ' zmniejszy się o ' + money(amt) + '.',
        sub: src + ' wzrośnie o ' + money(amt) + '.',
        set: src + ' zmieni się o ' + signed(e.before - e.after) + '.',
        move: src + ' wzrośnie, a ' + (e.to ? SOURCES[e.to].short.toLowerCase() : '') + ' zmniejszy się o ' + money(e.amount || 0) + '.'
      }[e.mode] || '');
    }
    el.entryDeleteHint.textContent = hint;
    el.entryDelete.disabled = blocked;
    openPanel(el.entrySheet);
  }

  function saveEntry() {
    var e = findEntry(entryId);
    if (!e) return;
    e.note = el.entryNote.value.trim();
    if (e.source !== 'loan' && e.mode === 'sub') e.cat = entryCat || 'other';
    save();
    render();
    el.entryNote.blur();
    closePanel(el.entrySheet);
    toast('Zapisano zmiany');
  }

  // Cofnięcie wpisu pożyczki: zmiana pożyczki (d) wraca, a gotówka/konto o tyle samo w drugą stronę
  function findLoanByName(name) {
    return state.loans.filter(function (l) { return l.name.toLowerCase() === String(name).toLowerCase(); })[0] || null;
  }
  function loanRevert(e) {
    var d = e.after - e.before;
    var l = findLoanByName(e.name);
    var cur = l ? l.amount : 0;
    var f = e.fund === 'cash' || e.fund === 'bank' ? e.fund : null;
    return { d: d, loan: l, cur: cur, next: cur - d, fund: f };
  }

  function deleteEntry() {
    var e = findEntry(entryId);
    if (!e) return;
    confirmAction('Usunąć ten wpis? ' + el.entryDeleteHint.textContent.replace(/^Usunięcie cofnie ten wpis[:.] /, ''), 'Usuń wpis', function () {
      var now = Date.now();
      if (e.source === 'loan') {
        var r = loanRevert(e);
        if (r.next < 0) return;
        var l = r.loan;
        if (!l && r.next > 0) {
          l = { id: uid(), name: e.name, amount: 0, since: e.at, note: '', fund: e.fund || 'none' };
          state.loans.push(l);
        }
        if (l) { l.amount = r.next; l.at = now; }
        if (l && r.next === 0) state.loans = state.loans.filter(function (x) { return x.id !== l.id; });
        if (r.fund) { state[r.fund] += r.d; state[r.fund + 'At'] = now; }
        state.loansAt = now;
        state.history = state.history.filter(function (x) { return x.id !== e.id; });
        save();
        render();
        closePanel(el.entrySheet);
        toast('Wpis usunięty');
        return;
      }
      if (e.mode === 'move') {
        state[e.source] += e.amount;
        state[e.to] -= e.amount;
        state[e.to + 'At'] = now;
      } else {
        state[e.source] -= (e.after - e.before);
      }
      state[e.source + 'At'] = now;
      state.history = state.history.filter(function (x) { return x.id !== e.id; });
      save();
      render();
      closePanel(el.entrySheet);
      toast('Wpis usunięty');
    });
  }

  // Przeciąganie arkuszy w dół (zamykanie gestem)
  [el.sheet, el.loansSheet, el.personSheet, el.historySheet, el.entrySheet, el.catSheet].forEach(function (panel) {
    var startY = 0, dy = 0, dragging = false;
    [panel.querySelector('.sheet-grabber'), panel.querySelector('.sheet-header')].forEach(function (h) {
      h.addEventListener('touchstart', function (e) {
        if (e.target.closest('button')) return;
        dragging = true; startY = e.touches[0].clientY; dy = 0;
        panel.classList.add('is-dragging');
      }, { passive: true });
    });
    window.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      panel.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    window.addEventListener('touchend', function () {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('is-dragging');
      if (dy > 110) {
        if (panel === el.sheet) closeEdit(); else closePanel(panel);
      } else panel.style.transform = '';
    });
  });

  // ---------- Action sheet (potwierdzenia) ----------
  // buttons: [{ text, danger, cb }]
  function actionChoices(title, buttons) {
    el.actionTitle.textContent = title;
    el.actionGroup.querySelectorAll('.action-btn').forEach(function (b) { b.remove(); });
    buttons.forEach(function (btn) {
      var b = document.createElement('button');
      b.className = 'action-btn' + (btn.danger ? ' action-btn--danger' : '') + (btn.bold ? ' action-btn--bold' : '');
      b.textContent = btn.text;
      b.addEventListener('click', function () { closeActions(); btn.cb(); });
      el.actionGroup.appendChild(b);
    });
    openPanel(el.actionSheet);
  }
  function confirmAction(title, btnText, cb) { actionChoices(title, [{ text: btnText, danger: true, cb: cb }]); }
  function closeActions() { closePanel(el.actionSheet); }

  // ---------- Toast ----------
  var toastTimer;
  function toast(msg) {
    el.toastText.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.toast.classList.add('is-open'); }); });
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('is-open');
      setTimeout(function () { if (!el.toast.classList.contains('is-open')) el.toast.hidden = true; }, 380);
    }, 1800);
  }

  // ---------- Karty (Środki / Statystyki) ----------
  function switchTab(name) {
    var stats = name === 'stats';
    el.viewHome.hidden = stats;
    el.viewStats.hidden = !stats;
    el.tabbar.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === name); });
    el.navbarTitle.textContent = stats ? 'Statystyki' : 'Środki';
    try { history.replaceState(null, '', stats ? '#stats' : location.pathname + location.search); } catch (e) { /* plik lokalny */ }
    window.scrollTo(0, 0);
    onScroll();
    if (stats) { selDay = null; renderStats(); }
  }

  // ---------- Zdarzenia ----------
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
  el.amountInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  el.nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.amountInput.focus(); } });
  el.nameInput.addEventListener('input', function () { el.sheetError.hidden = true; });
  el.noteInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  el.sheetSave.addEventListener('click', commit);
  el.sheetCancel.addEventListener('click', function () { closeEdit(); });
  el.fillAllBtn.addEventListener('click', function () { el.amountInput.value = toInput(currentValue()); updatePreview(); });

  el.entryCancel.addEventListener('click', function () { el.entryNote.blur(); closePanel(el.entrySheet); });
  el.entrySave.addEventListener('click', saveEntry);
  el.entryNote.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveEntry(); } });
  el.entryDelete.addEventListener('click', deleteEntry);

  // Wybór grupy
  el.catPickBtn.addEventListener('click', function () {
    el.amountInput.blur(); el.noteInput.blur();
    openCatPicker(selCat, function (id) { selCat = id; renderCatButton('catPick', id); });
  });
  el.entryCatPickBtn.addEventListener('click', function () {
    el.entryNote.blur();
    openCatPicker(entryCat, function (id) { entryCat = id; renderCatButton('entryCatPick', id); });
  });
  el.catCancel.addEventListener('click', function () { el.catSearch.blur(); closePanel(el.catSheet); });
  el.catSearch.addEventListener('input', renderCatResults);
  el.catSearch.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
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

  el.backdrop.addEventListener('click', function () {
    if (isOpen(el.actionSheet)) closeActions();
    else if (isOpen(el.catSheet)) closePanel(el.catSheet);
    else if (isOpen(el.sheet)) closeEdit(false);
    else if (isOpen(el.entrySheet)) closePanel(el.entrySheet);
    else if (isOpen(el.personSheet)) closePerson();
    else if (isOpen(el.historySheet)) closePanel(el.historySheet);
    else if (isOpen(el.loansSheet)) closePanel(el.loansSheet);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (isOpen(el.actionSheet)) closeActions();
    else if (isOpen(el.catSheet)) closePanel(el.catSheet);
    else if (isOpen(el.sheet)) closeEdit();
    else if (isOpen(el.entrySheet)) closePanel(el.entrySheet);
    else if (isOpen(el.personSheet)) closePerson();
    else if (isOpen(el.historySheet)) closePanel(el.historySheet);
    else if (isOpen(el.loansSheet)) closePanel(el.loansSheet);
  });

  // Historia
  el.history.addEventListener('click', function (e) {
    if (e.target.closest('#histAll')) openHistory();
  });
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
  el.monthNext.addEventListener('click', function () { if (selMonth < nowIdx) { selMonth++; selDay = null; renderStats(); } });
  el.savingsChart.addEventListener('click', function (e) {
    var r = e.target.closest('[data-m]');
    if (!r) return;
    selMonth = Number(r.getAttribute('data-m')); selDay = null; renderStats();
  });
  el.dailyChart.addEventListener('click', function (e) {
    var r = e.target.closest('[data-d]');
    if (!r) return;
    var d = Number(r.getAttribute('data-d'));
    selDay = selDay === d ? null : d;
    var months = computeMonths();
    renderDailyChart(months[selMonth] || emptyMonth());
  });
  el.addCatBtn.addEventListener('click', function () { addingCat = true; renderCustomCats(); });
  el.customCats.addEventListener('click', function (e) {
    var b = e.target.closest('[data-del-cat]');
    if (!b) return;
    var id = b.getAttribute('data-del-cat');
    var c = catById(id);
    confirmAction('Usunąć grupę „' + c.name + '”? Wydatki z tej grupy trafią do grupy „Inne”.', 'Usuń grupę', function () {
      state.customCats = state.customCats.filter(function (x) { return x.id !== id; });
      state.history.forEach(function (h) { if (h.cat === id) h.cat = 'other'; });
      save(); render(); toast('Grupa usunięta');
    });
  });
  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderStatsIfVisible, 150); });

  // Mały tytuł w pasku po przewinięciu dużego tytułu
  function onScroll() { el.navbar.classList.toggle('is-scrolled', window.scrollY > 36); }
  window.addEventListener('scroll', onScroll, { passive: true });

  // Odświeżaj czasy względne
  setInterval(function () { if (!anyOpen()) renderHome(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !anyOpen()) { state = load(); render(); } });

  paintIcons();
  renderHome();
  switchTab(location.hash === '#stats' ? 'stats' : 'home');

  // ---------- Service Worker ----------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
