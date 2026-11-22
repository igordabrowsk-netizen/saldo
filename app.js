/* Saldo — kontrola środków (gotówka, konto, pożyczone). Dane w localStorage, kwoty w groszach. */
(function () {
  'use strict';

  // ---------- Ikony (Lucide-style, stroke 2) ----------
  var P = {
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    landmark: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>',
    handCoins: '<path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17"/><path d="m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"/><path d="m2 16 6 6"/><circle cx="16" cy="9" r="2.9"/><circle cx="6" cy="5" r="3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.97 0 8.4 3.6 9.94 6.65a1 1 0 0 1 0 .7 13.2 13.2 0 0 1-1.67 2.68"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 13.16 13.16 0 0 1 4.45-5.15"/><path d="m2 2 20 20"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    equal: '<path d="M5 9h14"/><path d="M5 15h14"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
  }
  function paintIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      el.innerHTML = icon(el.getAttribute('data-icon'));
    });
  }

  // ---------- Dane ----------
  var KEY = 'saldo_v1';
  var SOURCES = {
    cash: { name: 'Gotówka', icon: 'banknote', cls: 'row-icon--green' },
    bank: { name: 'Konto bankowe', icon: 'landmark', cls: 'row-icon--blue' }
  };
  var HISTORY_LIMIT = 200;

  function defaultState() {
    return { cash: 0, bank: 0, cashAt: null, bankAt: null, loans: [], loansAt: null, lastFund: 'cash', history: [], privacy: false };
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      var s = JSON.parse(raw);
      var d = defaultState();
      for (var k in d) if (!(k in s)) s[k] = d[k];
      return s;
    } catch (e) { return defaultState(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* brak miejsca / tryb prywatny */ }
  }
  var state = load();

  function loansTotal() { return state.loans.reduce(function (s, l) { return s + l.amount; }, 0); }
  function findLoan(id) { for (var i = 0; i < state.loans.length; i++) if (state.loans[i].id === id) return state.loans[i]; return null; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---------- Formatowanie ----------
  var fmt = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  function money(grosze) {
    var neg = grosze < 0;
    var parts = fmt.format(Math.abs(grosze) / 100).split(',');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (neg ? '−' : '') + parts[0] + ',' + parts[1] + ' zł';
  }
  function shown(grosze) {
    return state.privacy ? '•••• zł' : money(grosze);
  }
  function parseAmount(str) {
    if (str == null) return NaN;
    var s = String(str).replace(/\s| /g, '').replace(/zł/gi, '').replace(',', '.');
    if (s === '' || s === '.') return NaN;
    if (!/^\d*\.?\d{0,2}$/.test(s)) return NaN;
    var n = Math.round(parseFloat(s) * 100);
    return isFinite(n) ? n : NaN;
  }
  function people(n) {
    if (n === 1) return '1 osoba';
    var d = n % 10, h = n % 100;
    return n + (d >= 2 && d <= 4 && (h < 12 || h > 14) ? ' osoby' : ' osób');
  }
  function initials(name) {
    var w = name.trim().split(/\s+/);
    return ((w[0] || '').charAt(0) + (w[1] || '').charAt(0)).toUpperCase() || '?';
  }

  var dayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  var timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });
  var dateFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short' });
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

  // ---------- Elementy ----------
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    today: $('today'), navbar: $('navbar'),
    totalAmount: $('totalAmount'), totalUpdated: $('totalUpdated'),
    splitCash: $('splitCash'), splitBank: $('splitBank'), splitLoan: $('splitLoan'),
    pctCash: $('pctCash'), pctBank: $('pctBank'), pctLoan: $('pctLoan'), legendLoan: $('legendLoan'),
    cashAmount: $('cashAmount'), bankAmount: $('bankAmount'), loansAmount: $('loansAmount'),
    cashUpdated: $('cashUpdated'), bankUpdated: $('bankUpdated'), loansSub: $('loansSub'), loansRow: $('loansRow'),
    history: $('history'), historyEmpty: $('historyEmpty'), clearHistoryBtn: $('clearHistoryBtn'),
    privacyBtn: $('privacyBtn'), privacyBtnSmall: $('privacyBtnSmall'),
    backdrop: $('backdrop'),
    sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetCancel: $('sheetCancel'), sheetSave: $('sheetSave'),
    modeControl: $('modeControl'), nameGroup: $('nameGroup'), nameInput: $('nameInput'),
    sheetCurrentLabel: $('sheetCurrentLabel'), sheetCurrent: $('sheetCurrent'),
    amountInput: $('amountInput'), amountSign: $('amountSign'),
    sheetPreview: $('sheetPreview'), previewValue: $('previewValue'),
    fundBlock: $('fundBlock'), fundLabel: $('fundLabel'), fundControl: $('fundControl'), fundHint: $('fundHint'),
    noteInput: $('noteInput'), sheetError: $('sheetError'), deleteLoanBtn: $('deleteLoanBtn'),
    loansSheet: $('loansSheet'), loansClose: $('loansClose'), loansAdd: $('loansAdd'), loansAddBig: $('loansAddBig'),
    loansTotal: $('loansTotal'), loanList: $('loanList'), loansEmpty: $('loansEmpty'),
    actionSheet: $('actionSheet'), actionTitle: $('actionTitle'), actionConfirm: $('actionConfirm'), actionCancel: $('actionCancel'),
    toast: $('toast'), toastText: $('toastText')
  };

  // ---------- Render ----------
  var historyShown = 10;

  function render() {
    var lt = loansTotal();
    var total = state.cash + state.bank + lt;
    el.today.textContent = dayFmt.format(new Date());

    el.totalAmount.textContent = shown(total);
    el.totalAmount.classList.toggle('is-long', !state.privacy && Math.abs(total) >= 10000000);
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

    el.cashAmount.textContent = shown(state.cash);
    el.bankAmount.textContent = shown(state.bank);
    el.loansAmount.textContent = shown(lt);
    el.cashAmount.style.color = state.cash < 0 ? 'var(--red)' : '';
    el.bankAmount.style.color = state.bank < 0 ? 'var(--red)' : '';
    el.cashUpdated.textContent = state.cashAt ? when(state.cashAt) : 'Stuknij, aby ustawić';
    el.bankUpdated.textContent = state.bankAt ? when(state.bankAt) : 'Stuknij, aby ustawić';
    el.loansSub.textContent = state.loans.length ? people(state.loans.length) : 'Stuknij, aby dodać';

    var privIcon = icon(state.privacy ? 'eyeOff' : 'eye');
    var privLabel = state.privacy ? 'Pokaż kwoty' : 'Ukryj kwoty';
    [el.privacyBtn, el.privacyBtnSmall].forEach(function (x) { x.innerHTML = privIcon; x.setAttribute('aria-label', privLabel); });
    document.body.classList.toggle('privacy', state.privacy);

    renderHistory();
    renderLoans();
  }

  function renderLoans() {
    el.loansTotal.textContent = shown(loansTotal());
    el.loansEmpty.hidden = state.loans.length > 0;
    var sorted = state.loans.slice().sort(function (a, b) { return b.amount - a.amount; });
    el.loanList.innerHTML = sorted.map(function (l) {
      return '<li><button class="row" data-loan="' + esc(l.id) + '">' +
        '<span class="avatar">' + esc(initials(l.name)) + '</span>' +
        '<span class="row-body"><span class="row-title">' + esc(l.name) + '</span>' +
        '<span class="row-sub">Od ' + esc(dateFmt.format(new Date(l.since))) + (l.note ? ' · ' + esc(l.note) : '') + '</span></span>' +
        '<span class="row-value amount">' + shown(l.amount) + '</span>' +
        '<span class="row-chevron ic">' + icon('chevronRight') + '</span>' +
        '</button></li>';
    }).join('');
  }

  var FUND_FROM = { cash: ' z gotówki', bank: ' z konta', none: '' };
  var FUND_TO = { cash: ' do gotówki', bank: ' na konto', none: '' };

  function renderHistory() {
    var h = state.history;
    el.historyEmpty.hidden = h.length > 0;
    el.history.hidden = h.length === 0;
    el.clearHistoryBtn.hidden = h.length === 0;
    var items = h.slice(0, historyShown).map(function (e) {
      var delta = e.after - e.before;
      var ic, bg, title, sub, cls;
      if (e.source === 'loan') {
        var f = e.fund || 'none';
        if (e.mode === 'add') { ic = 'handCoins'; bg = 'row-icon--orange'; sub = 'Pożyczka' + FUND_FROM[f]; }
        else if (e.mode === 'sub') { ic = 'undo'; bg = 'row-icon--green'; sub = (e.after === 0 ? 'Zwrot całości' : 'Zwrot') + FUND_TO[f]; }
        else if (e.mode === 'del') { ic = 'trash'; bg = 'row-icon--gray'; sub = 'Usunięto pożyczkę'; }
        else { ic = 'equal'; bg = 'row-icon--indigo'; sub = 'Korekta pożyczki'; }
        title = e.note ? e.name + ': ' + e.note : e.name;
        cls = 'loan';
      } else {
        var src = SOURCES[e.source];
        ic = e.mode === 'set' ? 'equal' : delta >= 0 ? 'plus' : 'minus';
        bg = e.mode === 'set' ? 'row-icon--indigo' : delta >= 0 ? 'row-icon--green' : 'row-icon--red';
        title = e.note || (e.mode === 'set' ? 'Ustawiono stan' : delta >= 0 ? 'Wpłata' : 'Wydatek');
        sub = src.name;
        cls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'neu';
      }
      var deltaTxt = state.privacy ? '••••' : (delta > 0 ? '+' : '') + money(delta);
      return '<li><div class="row hist-row">' +
        '<span class="row-icon ' + bg + '">' + icon(ic) + '</span>' +
        '<span class="row-body"><span class="row-title">' + esc(title) + '</span><span class="row-sub">' + esc(sub + ' · ' + when(e.at)) + '</span></span>' +
        '<span class="hist-right"><span class="hist-delta amount ' + cls + '">' + deltaTxt + '</span>' +
        '<span class="hist-after amount">' + shown(e.after) + '</span></span>' +
        '</div></li>';
    });
    if (h.length > historyShown) {
      items.push('<li><button class="hist-more" id="histMore">Pokaż więcej (' + (h.length - historyShown) + ')</button></li>');
    }
    el.history.innerHTML = items.join('');
    var more = document.getElementById('histMore');
    if (more) more.addEventListener('click', function () { historyShown += 20; renderHistory(); });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- Arkusze (wspólne) ----------
  function anyOpen() {
    return [el.sheet, el.loansSheet, el.actionSheet].some(function (s) { return s.classList.contains('is-open'); });
  }
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
    var btns = control.querySelectorAll('button[' + attr + ']');
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

  var MODE_LABELS = {
    source: { set: 'Ustaw', add: 'Dodaj', sub: 'Odejmij' },
    loan: { set: 'Ustaw', add: 'Pożyczam', sub: 'Zwrot' }
  };

  function currentValue() {
    if (ctx.type === 'source') return state[ctx.key];
    if (ctx.type === 'loan') { var l = findLoan(ctx.id); return l ? l.amount : 0; }
    return 0;
  }

  function openEdit(c) {
    ctx = c;
    var labels = MODE_LABELS[c.type === 'source' ? 'source' : 'loan'];
    el.modeControl.querySelectorAll('button[data-mode]').forEach(function (b) { b.textContent = labels[b.getAttribute('data-mode')]; });

    if (c.type === 'source') {
      el.sheetTitle.textContent = SOURCES[c.key].name;
      el.sheetCurrentLabel.textContent = 'Obecnie';
    } else if (c.type === 'loan') {
      el.sheetTitle.textContent = findLoan(c.id).name;
      el.sheetCurrentLabel.textContent = 'Jest Ci winien';
    } else {
      el.sheetTitle.textContent = 'Nowa pożyczka';
      el.sheetCurrentLabel.textContent = 'Kwota pożyczki';
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

    var startMode = c.type === 'newLoan' ? 'add' : c.type === 'loan' ? 'sub' : (state[c.key + 'At'] ? 'add' : 'set');
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
    el.amountSign.textContent = m === 'add' ? '+' : m === 'sub' ? '−' : '';
    el.amountSign.className = 'amount-sign' + (m === 'add' ? ' pos' : m === 'sub' ? ' neg' : '');
    if (ctx.type !== 'source') el.amountSign.textContent = '';
    if (resetValue) {
      var setPrefill = m === 'set' && (ctx.type === 'loan' || (ctx.type === 'source' && state[ctx.key + 'At']));
      el.amountInput.value = setPrefill ? toInput(currentValue()) : '';
    }
    var showFund = ctx.type !== 'source' && m !== 'set';
    el.fundBlock.hidden = !showFund;
    el.fundLabel.textContent = m === 'sub' ? 'Zwrot trafia do' : 'Pieniądze pochodzą z';
    el.sheetError.hidden = true;
    updatePreview();
  }

  function toInput(grosze) {
    return (grosze / 100).toFixed(2).replace('.', ',');
  }

  function computeNew() {
    var v = parseAmount(el.amountInput.value);
    if (isNaN(v)) return null;
    var cur = currentValue();
    if (mode === 'set') return v;
    if (mode === 'add') return cur + v;
    return cur - v;
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
    updateFundHint(isNaN(v) ? 0 : v);
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
      var name = fund === 'cash' ? 'Gotówka' : 'Konto';
      var cur = state[fund];
      el.fundHint.innerHTML = name + ': <b>' + money(cur) + '</b> → <b>' + money(cur + sign * v) + '</b>. Łączna suma bez zmian.';
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
      var bf = state[ctx.key];
      if (mode !== 'set' && n === bf) { showError('Kwota musi być większa od zera.'); return; }
      state[ctx.key] = n;
      state[ctx.key + 'At'] = now;
      pushHistory({ source: ctx.key, mode: mode, before: bf, after: n, at: now, note: note });
      msg = SOURCES[ctx.key].name + ': zapisano';
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

  // Przeciąganie arkuszy w dół (zamykanie gestem)
  [el.sheet, el.loansSheet].forEach(function (panel) {
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
        if (panel === el.sheet) closeEdit(); else closePanel(el.loansSheet);
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

  el.backdrop.addEventListener('click', function () {
    if (el.actionSheet.classList.contains('is-open')) closeActions();
    else if (el.sheet.classList.contains('is-open')) closeEdit(false);
    else if (el.loansSheet.classList.contains('is-open')) closePanel(el.loansSheet);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (el.actionSheet.classList.contains('is-open')) closeActions();
    else if (el.sheet.classList.contains('is-open')) closeEdit();
    else if (el.loansSheet.classList.contains('is-open')) closePanel(el.loansSheet);
  });

  function togglePrivacy() { state.privacy = !state.privacy; save(); render(); }
  el.privacyBtn.addEventListener('click', togglePrivacy);
  el.privacyBtnSmall.addEventListener('click', togglePrivacy);

  el.clearHistoryBtn.addEventListener('click', function () {
    confirmAction('Wyczyścić całą historię zmian? Kwoty zostaną bez zmian.', 'Wyczyść historię', function () {
      state.history = []; historyShown = 10; save(); render(); toast('Historia wyczyszczona');
    });
  });
  el.actionCancel.addEventListener('click', closeActions);
  el.actionConfirm.addEventListener('click', function () {
    var cb = actionCb;
    closeActions();
    if (cb) cb();
  });

  // Mały tytuł w pasku po przewinięciu dużego tytułu
  function onScroll() { el.navbar.classList.toggle('is-scrolled', window.scrollY > 36); }
  window.addEventListener('scroll', onScroll, { passive: true });

  // Odświeżaj czasy względne
  setInterval(render, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !anyOpen()) { state = load(); render(); } });

  paintIcons();
  render();
  onScroll();

  // ---------- Service Worker ----------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
