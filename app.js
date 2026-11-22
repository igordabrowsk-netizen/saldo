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

  // Chipy wyboru grupy (wspólne dla arkusza kwoty i szczegółów wpisu)
  function renderChips(container, selectedId, onPick) {
    var html = sortedCats().map(function (c) {
      return '<button type="button" class="chip' + (c.id === selectedId ? ' is-selected' : '') + '" data-cat="' + esc(c.id) + '">' +
        '<span class="chip-dot" style="background:' + c.color + '">' + icon(c.icon) + '</span>' + esc(c.name) + '</button>';
    }).join('');
    html += '<button type="button" class="chip chip--add" data-cat-add>' + icon('plus') + 'Nowa grupa</button>';
    container.innerHTML = html;
    container.scrollLeft = 0;

    container.onclick = function (e) {
      var add = e.target.closest('[data-cat-add]');
      if (add) {
        var wrap = document.createElement('span');
        wrap.className = 'chip chip--input';
        wrap.innerHTML = '<input type="text" maxlength="24" placeholder="Nazwa grupy" enterkeyhint="done"><button type="button" aria-label="Dodaj grupę">' + icon('check') + '</button>';
        add.replaceWith(wrap);
        var inp = wrap.querySelector('input');
        var confirm = function () {
          var c = addCustomCat(inp.value);
          if (!c) { inp.focus(); return; }
          onPick(c.id);
          renderChips(container, c.id, onPick);
          var sel = container.querySelector('.is-selected');
          if (sel) container.scrollLeft = Math.max(0, sel.offsetLeft - 16);
          renderStatsIfVisible();
        };
        inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); confirm(); } });
        wrap.querySelector('button').addEventListener('click', confirm);
        inp.focus();
        container.scrollLeft = container.scrollWidth;
        return;
      }
      var b = e.target.closest('[data-cat]');
      if (!b) return;
      var id = b.getAttribute('data-cat');
      onPick(id);
      container.querySelectorAll('.chip.is-selected').forEach(function (x) { x.classList.remove('is-selected'); });
      b.classList.add('is-selected');
    };
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
    history: $('history'), historyEmpty: $('historyEmpty'), clearHistoryBtn: $('clearHistoryBtn'),
    backdrop: $('backdrop'),
    sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetCancel: $('sheetCancel'), sheetSave: $('sheetSave'),
    modeControl: $('modeControl'), nameGroup: $('nameGroup'), nameInput: $('nameInput'),
    sheetCurrentLabel: $('sheetCurrentLabel'), sheetCurrent: $('sheetCurrent'),
    amountInput: $('amountInput'), amountSign: $('amountSign'),
    sheetPreview: $('sheetPreview'), previewValue: $('previewValue'),
    catBlock: $('catBlock'), catChips: $('catChips'), moveHint: $('moveHint'),
    fundBlock: $('fundBlock'), fundLabel: $('fundLabel'), fundControl: $('fundControl'), fundHint: $('fundHint'),
    noteInput: $('noteInput'), sheetError: $('sheetError'), deleteLoanBtn: $('deleteLoanBtn'),
    loansSheet: $('loansSheet'), loansClose: $('loansClose'), loansAdd: $('loansAdd'), loansAddBig: $('loansAddBig'),
    loansTotal: $('loansTotal'), loanList: $('loanList'), loansEmpty: $('loansEmpty'),
    entrySheet: $('entrySheet'), entryCancel: $('entryCancel'), entrySave: $('entrySave'),
    entryIcon: $('entryIcon'), entryAmount: $('entryAmount'), entryMeta: $('entryMeta'),
    entryCatBlock: $('entryCatBlock'), entryChips: $('entryChips'), entryNote: $('entryNote'),
    entryDelete: $('entryDelete'), entryDeleteHint: $('entryDeleteHint'),
    monthPrev: $('monthPrev'), monthNext: $('monthNext'), monthLabel: $('monthLabel'),
    savingsLabel: $('savingsLabel'), savingsAmount: $('savingsAmount'), savingsRate: $('savingsRate'),
    incomeAmount: $('incomeAmount'), expenseAmount: $('expenseAmount'),
    savingsChart: $('savingsChart'), savingsCaption: $('savingsCaption'),
    catStats: $('catStats'), catStatsEmpty: $('catStatsEmpty'),
    dailyChart: $('dailyChart'), dailyReadout: $('dailyReadout'),
    customCats: $('customCats'), customCatsHint: $('customCatsHint'), addCatBtn: $('addCatBtn'),
    actionSheet: $('actionSheet'), actionTitle: $('actionTitle'), actionConfirm: $('actionConfirm'), actionCancel: $('actionCancel'),
    toast: $('toast'), toastText: $('toastText')
  };

  // ---------- Render: Środki ----------
  var historyShown = 15;

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
      else if (e.mode === 'sub') { d.ic = 'undo'; d.cls = 'row-icon--green'; d.sub = (e.after === 0 ? 'Zwrot całości' : 'Zwrot') + FUND_TO[f]; }
      else if (e.mode === 'del') { d.ic = 'trash'; d.cls = 'row-icon--gray'; d.sub = 'Usunięto pożyczkę'; }
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

  function renderHistory() {
    var h = state.history;
    el.historyEmpty.hidden = h.length > 0;
    el.history.hidden = h.length === 0;
    el.clearHistoryBtn.hidden = h.length === 0;
    var items = h.slice(0, historyShown).map(function (e) {
      var d = describe(e);
      var editable = e.source !== 'loan';
      var deltaTxt = e.mode === 'move' ? money(d.delta) : signed(d.delta);
      var inner = iconBadge(d) +
        '<span class="row-body"><span class="row-title">' + esc(d.title) + '</span><span class="row-sub">' + esc(d.sub + ' · ' + when(e.at)) + '</span></span>' +
        '<span class="hist-right"><span class="hist-delta amount ' + d.deltaCls + '">' + deltaTxt + '</span>' +
        '<span class="hist-after amount">' + money(e.after) + '</span></span>';
      return editable
        ? '<li><button class="row hist-row" data-entry="' + esc(e.id) + '">' + inner + '</button></li>'
        : '<li><div class="row hist-row">' + inner + '</div></li>';
    });
    if (h.length > historyShown) {
      items.push('<li><button class="hist-more" id="histMore">Pokaż więcej (' + (h.length - historyShown) + ')</button></li>');
    }
    el.history.innerHTML = items.join('');
    var more = document.getElementById('histMore');
    if (more) more.addEventListener('click', function () { historyShown += 30; renderHistory(); });
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
  var PANELS = [el.sheet, el.loansSheet, el.entrySheet, el.actionSheet];
  function anyOpen() { return PANELS.some(function (s) { return s.classList.contains('is-open'); }); }
  function openPanel(panel) {
    document.body.classList.add('no-scroll');
    el.backdrop.hidden = false;
    panel.hidden = false;
    panel.style.transform = '';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.backdrop.classList.add('is-open');
        panel.classList.add('is-open');
      });
    });
  }
  function closePanel(panel) {
    panel.classList.remove('is-open');
    panel.style.transform = '';
    if (!anyOpen()) {
      el.backdrop.classList.remove('is-open');
      document.body.classList.remove('no-scroll');
    }
    setTimeout(function () {
      if (!panel.classList.contains('is-open')) panel.hidden = true;
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
    loan: { set: 'Ustaw', add: 'Pożyczam', sub: 'Zwrot', move: '' }
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
      el.sheetTitle.textContent = findLoan(c.id).name;
      el.sheetCurrentLabel.textContent = 'Jest Ci winien';
    } else {
      el.sheetTitle.textContent = 'Nowa pożyczka';
    }
    el.modeControl.hidden = c.type === 'newLoan';
    el.nameGroup.hidden = c.type !== 'newLoan';
    el.sheetCurrent.parentNode.hidden = c.type === 'newLoan';
    el.deleteLoanBtn.hidden = c.type !== 'loan';
    el.sheetCurrent.textContent = money(currentValue());
    el.nameInput.value = '';
    el.noteInput.value = '';
    el.sheetError.hidden = true;
    fund = state.lastFund || 'cash';
    setSegment(el.fundControl, 'data-fund', fund);
    selCat = null;
    if (isSource) renderChips(el.catChips, null, function (id) { selCat = id; });

    var startMode = c.type === 'newLoan' ? 'add' : c.type === 'loan' ? 'sub' : (state[c.key + 'At'] ? 'sub' : 'set');
    setMode(startMode, true);

    openPanel(el.sheet);
    // iOS pokaże klawiaturę tylko przy focus w obrębie gestu użytkownika
    (c.type === 'newLoan' ? el.nameInput : el.amountInput).focus({ preventScroll: true });
  }

  function closeEdit(reopenLoans) {
    el.amountInput.blur(); el.noteInput.blur(); el.nameInput.blur();
    var back = ctx && ctx.type !== 'source' && reopenLoans !== false && state.loans.length > 0;
    closePanel(el.sheet);
    if (back) openPanel(el.loansSheet);
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
    el.fundLabel.textContent = m === 'sub' ? 'Zwrot trafia do' : 'Pieniądze pochodzą z';
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
      if (!loan) { loan = { id: uid(), name: name, amount: 0, since: now, note: '' }; state.loans.push(loan); }
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
      if (n < 0) { showError('Zwrot nie może być większy niż pożyczka (' + money(l.amount) + ').'); return; }
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
        msg = mode === 'sub' ? 'Zwrot zapisany' : 'Zapisano';
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

  function deleteLoan() {
    var l = findLoan(ctx.id);
    if (!l) return;
    confirmAction('Usunąć pożyczkę: ' + l.name + ' (' + money(l.amount) + ')? Gotówka i konto pozostaną bez zmian, łączna suma zmniejszy się o tę kwotę.', 'Usuń pożyczkę', function () {
      var now = Date.now();
      state.loans = state.loans.filter(function (x) { return x.id !== l.id; });
      state.loansAt = now;
      pushHistory({ source: 'loan', name: l.name, mode: 'del', fund: 'none', before: l.amount, after: 0, at: now, note: '' });
      save();
      render();
      closeEdit();
      toast('Pożyczka usunięta');
    });
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
    el.entryCatBlock.hidden = e.mode !== 'sub';
    entryCat = e.cat || 'other';
    if (e.mode === 'sub') renderChips(el.entryChips, entryCat, function (cid) { entryCat = cid; });

    var src = SOURCES[e.source].short;
    var amt = Math.abs(e.after - e.before);
    var hint = {
      add: src + ' zmniejszy się o ' + money(amt) + '.',
      sub: src + ' wzrośnie o ' + money(amt) + '.',
      set: src + ' zmieni się o ' + signed(e.before - e.after) + '.',
      move: src + ' wzrośnie, a ' + (e.to ? SOURCES[e.to].short.toLowerCase() : '') + ' zmniejszy się o ' + money(e.amount || 0) + '.'
    }[e.mode] || '';
    el.entryDeleteHint.textContent = 'Usunięcie cofnie ten wpis: ' + hint;
    openPanel(el.entrySheet);
    var sel = el.entryChips.querySelector('.is-selected');
    if (sel) setTimeout(function () { el.entryChips.scrollLeft = Math.max(0, sel.offsetLeft - 16); }, 30);
  }

  function saveEntry() {
    var e = findEntry(entryId);
    if (!e) return;
    e.note = el.entryNote.value.trim();
    if (e.mode === 'sub') e.cat = entryCat || 'other';
    save();
    render();
    el.entryNote.blur();
    closePanel(el.entrySheet);
    toast('Zapisano zmiany');
  }

  function deleteEntry() {
    var e = findEntry(entryId);
    if (!e) return;
    confirmAction('Usunąć ten wpis? ' + el.entryDeleteHint.textContent.replace('Usunięcie cofnie ten wpis: ', ''), 'Usuń wpis', function () {
      var now = Date.now();
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
  [el.sheet, el.loansSheet, el.entrySheet].forEach(function (panel) {
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
  var actionCb = null;
  function confirmAction(title, btnText, cb) {
    el.actionTitle.textContent = title;
    el.actionConfirm.textContent = btnText;
    actionCb = cb;
    openPanel(el.actionSheet);
  }
  function closeActions() { actionCb = null; closePanel(el.actionSheet); }

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
  function newLoanFromList() { closePanel(el.loansSheet); openEdit({ type: 'newLoan' }); }
  el.loansAdd.addEventListener('click', newLoanFromList);
  el.loansAddBig.addEventListener('click', newLoanFromList);
  el.loanList.addEventListener('click', function (e) {
    var b = e.target.closest('[data-loan]');
    if (!b) return;
    closePanel(el.loansSheet);
    openEdit({ type: 'loan', id: b.getAttribute('data-loan') });
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
  el.deleteLoanBtn.addEventListener('click', deleteLoan);

  el.entryCancel.addEventListener('click', function () { el.entryNote.blur(); closePanel(el.entrySheet); });
  el.entrySave.addEventListener('click', saveEntry);
  el.entryNote.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveEntry(); } });
  el.entryDelete.addEventListener('click', deleteEntry);

  el.backdrop.addEventListener('click', function () {
    if (el.actionSheet.classList.contains('is-open')) closeActions();
    else if (el.sheet.classList.contains('is-open')) closeEdit(false);
    else if (el.entrySheet.classList.contains('is-open')) closePanel(el.entrySheet);
    else if (el.loansSheet.classList.contains('is-open')) closePanel(el.loansSheet);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (el.actionSheet.classList.contains('is-open')) closeActions();
    else if (el.sheet.classList.contains('is-open')) closeEdit();
    else if (el.entrySheet.classList.contains('is-open')) closePanel(el.entrySheet);
    else if (el.loansSheet.classList.contains('is-open')) closePanel(el.loansSheet);
  });

  el.clearHistoryBtn.addEventListener('click', function () {
    confirmAction('Wyczyścić całą historię zmian? Kwoty zostaną bez zmian, ale statystyki wydatków i odkładania też zostaną wyczyszczone.', 'Wyczyść historię', function () {
      state.history = []; historyShown = 15; save(); render(); toast('Historia wyczyszczona');
    });
  });
  el.actionCancel.addEventListener('click', closeActions);
  el.actionConfirm.addEventListener('click', function () {
    var cb = actionCb;
    closeActions();
    if (cb) cb();
  });

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
