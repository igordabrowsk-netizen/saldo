/* Saldo — kontrola środków (gotówka + konto). Dane w localStorage, kwoty w groszach. */
(function () {
  'use strict';

  // ---------- Ikony (Lucide-style, stroke 2) ----------
  var P = {
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    landmark: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>',
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
    return { cash: 0, bank: 0, cashAt: null, bankAt: null, history: [], privacy: false };
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

  // ---------- Formatowanie ----------
  var fmt = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
  function money(grosze) {
    // pl-PL nie grupuje liczb 4-cyfrowych – wymuszamy spację tysięcy dla czytelności
    var neg = grosze < 0;
    var abs = Math.abs(grosze) / 100;
    var parts = fmt.format(abs).replace(/\s/g, '').split(',');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (neg ? '−' : '') + parts[0] + ',' + parts[1] + ' zł';
  }
  function shown(grosze) {
    return state.privacy ? '•••• zł' : money(grosze);
  }
  function parseAmount(str) {
    if (str == null) return NaN;
    var s = String(str).replace(/\s| /g, '').replace(/zł/gi, '').replace(',', '.');
    if (s === '') return NaN;
    if (!/^\d*\.?\d{0,2}$/.test(s)) return NaN;
    var n = Math.round(parseFloat(s) * 100);
    return isFinite(n) ? n : NaN;
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
    splitCash: $('splitCash'), splitBank: $('splitBank'), pctCash: $('pctCash'), pctBank: $('pctBank'),
    cashAmount: $('cashAmount'), bankAmount: $('bankAmount'),
    cashUpdated: $('cashUpdated'), bankUpdated: $('bankUpdated'),
    history: $('history'), historyEmpty: $('historyEmpty'), clearHistoryBtn: $('clearHistoryBtn'),
    privacyBtn: $('privacyBtn'), privacyBtnSmall: $('privacyBtnSmall'),
    backdrop: $('backdrop'), sheet: $('sheet'), sheetTitle: $('sheetTitle'),
    sheetCancel: $('sheetCancel'), sheetSave: $('sheetSave'), sheetGrabber: $('sheetGrabber'),
    modeControl: $('modeControl'), segThumb: $('segThumb'),
    sheetCurrent: $('sheetCurrent'), amountInput: $('amountInput'), amountSign: $('amountSign'),
    sheetPreview: $('sheetPreview'), previewValue: $('previewValue'),
    noteInput: $('noteInput'), sheetError: $('sheetError'),
    actionSheet: $('actionSheet'), confirmClear: $('confirmClear'), cancelClear: $('cancelClear'),
    toast: $('toast'), toastText: $('toastText')
  };

  // ---------- Render ----------
  var historyShown = 10;

  function render() {
    var total = state.cash + state.bank;
    el.today.textContent = dayFmt.format(new Date());

    el.totalAmount.textContent = shown(total);
    el.totalAmount.classList.toggle('is-long', !state.privacy && Math.abs(total) >= 10000000);
    var last = Math.max(state.cashAt || 0, state.bankAt || 0);
    el.totalUpdated.textContent = last ? 'Aktualizacja: ' + when(last).toLowerCase() : '';

    var pos = Math.max(state.cash, 0) + Math.max(state.bank, 0);
    var pc = pos > 0 ? Math.round(Math.max(state.cash, 0) / pos * 100) : 0;
    var pb = pos > 0 ? 100 - pc : 0;
    el.splitCash.style.width = pc + '%';
    el.splitBank.style.width = pb + '%';
    el.splitCash.style.display = pc ? '' : 'none';
    el.splitBank.style.display = pb ? '' : 'none';
    el.pctCash.textContent = pc + '%';
    el.pctBank.textContent = pb + '%';

    el.cashAmount.textContent = shown(state.cash);
    el.bankAmount.textContent = shown(state.bank);
    el.cashAmount.style.color = state.cash < 0 ? 'var(--red)' : '';
    el.bankAmount.style.color = state.bank < 0 ? 'var(--red)' : '';
    el.cashUpdated.textContent = state.cashAt ? when(state.cashAt) : 'Stuknij, aby ustawić';
    el.bankUpdated.textContent = state.bankAt ? when(state.bankAt) : 'Stuknij, aby ustawić';

    var privIcon = icon(state.privacy ? 'eyeOff' : 'eye');
    var privLabel = state.privacy ? 'Pokaż kwoty' : 'Ukryj kwoty';
    [el.privacyBtn, el.privacyBtnSmall].forEach(function (b) { b.innerHTML = privIcon; b.setAttribute('aria-label', privLabel); });
    document.body.classList.toggle('privacy', state.privacy);

    renderHistory();
  }

  function renderHistory() {
    var h = state.history;
    el.historyEmpty.hidden = h.length > 0;
    el.history.hidden = h.length === 0;
    el.clearHistoryBtn.hidden = h.length === 0;
    var items = h.slice(0, historyShown).map(function (e) {
      var src = SOURCES[e.source];
      var delta = e.after - e.before;
      var cls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'neu';
      var ic = e.mode === 'set' ? 'equal' : delta >= 0 ? 'plus' : 'minus';
      var bg = e.mode === 'set' ? 'row-icon--indigo' : delta >= 0 ? 'row-icon--green' : 'row-icon--red';
      var action = e.mode === 'set' ? 'Ustawiono stan' : delta >= 0 ? 'Wpłata' : 'Wydatek';
      var deltaTxt = state.privacy ? '••••' : (delta > 0 ? '+' : '') + money(delta);
      var title = esc(e.note || action);
      var sub = esc(src.name) + ' · ' + esc(when(e.at));
      return '<li><div class="row hist-row">' +
        '<span class="row-icon ' + bg + '">' + icon(ic) + '</span>' +
        '<span class="row-body"><span class="row-title">' + title + '</span><span class="row-sub">' + sub + '</span></span>' +
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

  // ---------- Arkusz edycji ----------
  var sheetSource = null;
  var mode = 'set';
  var MODES = ['set', 'add', 'sub'];

  function openSheet(source) {
    sheetSource = source;
    el.sheetTitle.textContent = SOURCES[source].name;
    el.sheetCurrent.textContent = money(state[source]);
    el.noteInput.value = '';
    el.sheetError.hidden = true;
    setMode(state[source + 'At'] ? 'add' : 'set', true);

    document.body.classList.add('no-scroll');
    el.backdrop.hidden = false;
    el.sheet.hidden = false;
    el.sheet.style.transform = '';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.backdrop.classList.add('is-open');
        el.sheet.classList.add('is-open');
      });
    });
    // iOS pokaże klawiaturę tylko przy focus w obrębie gestu użytkownika
    el.amountInput.focus({ preventScroll: true });
  }

  function closeSheet() {
    el.amountInput.blur();
    el.noteInput.blur();
    el.backdrop.classList.remove('is-open');
    el.sheet.classList.remove('is-open');
    el.sheet.style.transform = '';
    document.body.classList.remove('no-scroll');
    setTimeout(function () {
      if (!el.sheet.classList.contains('is-open')) { el.sheet.hidden = true; el.backdrop.hidden = true; }
    }, 380);
  }

  function setMode(m, resetValue) {
    mode = m;
    var idx = MODES.indexOf(m);
    el.segThumb.style.transform = 'translateX(' + (idx * 100) + '%)';
    el.modeControl.querySelectorAll('button').forEach(function (b) {
      var on = b.getAttribute('data-mode') === m;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    el.amountSign.textContent = m === 'add' ? '+' : m === 'sub' ? '−' : '';
    el.amountSign.className = 'amount-sign' + (m === 'add' ? ' pos' : m === 'sub' ? ' neg' : '');
    if (resetValue) {
      el.amountInput.value = m === 'set' && state[sheetSource + 'At'] ? toInput(state[sheetSource]) : '';
    }
    el.sheetError.hidden = true;
    updatePreview();
  }

  function toInput(grosze) {
    return (grosze / 100).toFixed(2).replace('.', ',');
  }

  function computeNew() {
    var v = parseAmount(el.amountInput.value);
    if (isNaN(v)) return null;
    var cur = state[sheetSource];
    if (mode === 'set') return v;
    if (mode === 'add') return cur + v;
    return cur - v;
  }

  function updatePreview() {
    var n = computeNew();
    var valid = n !== null && !(mode !== 'set' && parseAmount(el.amountInput.value) === 0);
    el.sheetSave.disabled = !valid;
    if (n === null) {
      el.sheetPreview.style.visibility = 'hidden';
      return;
    }
    el.sheetPreview.style.visibility = '';
    el.previewValue.textContent = money(n);
    el.sheetPreview.classList.toggle('is-negative', n < 0);
  }

  function sanitizeInput() {
    var v = el.amountInput.value.replace(/\./g, ',').replace(/[^\d,]/g, '');
    var i = v.indexOf(',');
    if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/,/g, '').slice(0, 2);
    if (v.length > 1 && v[0] === '0' && v[1] !== ',') v = v.replace(/^0+/, '') || '0';
    if (v.replace(',', '').length > 11) v = v.slice(0, -1);
    if (v !== el.amountInput.value) el.amountInput.value = v;
  }

  function commit() {
    var n = computeNew();
    if (n === null) { showError('Wpisz poprawną kwotę.'); return; }
    var before = state[sheetSource];
    if (mode !== 'set' && n === before) { showError('Kwota musi być większa od zera.'); return; }
    var now = Date.now();
    state[sheetSource] = n;
    state[sheetSource + 'At'] = now;
    state.history.unshift({
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      source: sheetSource, mode: mode, before: before, after: n, at: now,
      note: el.noteInput.value.trim()
    });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    save();
    render();
    closeSheet();
    toast(SOURCES[sheetSource].name + ': zapisano');
  }

  function showError(msg) {
    el.sheetError.textContent = msg;
    el.sheetError.hidden = false;
  }

  // Przeciąganie arkusza w dół (zamykanie gestem)
  (function enableDrag() {
    var startY = 0, dy = 0, dragging = false;
    var handles = [el.sheetGrabber, el.sheet.querySelector('.sheet-header')];
    handles.forEach(function (h) {
      h.addEventListener('touchstart', function (e) {
        if (e.target.closest('button')) return;
        dragging = true; startY = e.touches[0].clientY; dy = 0;
        el.sheet.classList.add('is-dragging');
      }, { passive: true });
    });
    window.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      el.sheet.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    window.addEventListener('touchend', function () {
      if (!dragging) return;
      dragging = false;
      el.sheet.classList.remove('is-dragging');
      if (dy > 110) closeSheet(); else el.sheet.style.transform = '';
    });
  })();

  // ---------- Action sheet ----------
  function openActions() {
    el.backdrop.hidden = false;
    el.actionSheet.hidden = false;
    document.body.classList.add('no-scroll');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.backdrop.classList.add('is-open');
        el.actionSheet.classList.add('is-open');
      });
    });
  }
  function closeActions() {
    el.backdrop.classList.remove('is-open');
    el.actionSheet.classList.remove('is-open');
    document.body.classList.remove('no-scroll');
    setTimeout(function () {
      if (!el.actionSheet.classList.contains('is-open')) {
        el.actionSheet.hidden = true;
        if (!el.sheet.classList.contains('is-open')) el.backdrop.hidden = true;
      }
    }, 360);
  }

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
    b.addEventListener('click', function () { openSheet(b.getAttribute('data-source')); });
  });
  el.modeControl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b && b.getAttribute('data-mode') !== mode) { setMode(b.getAttribute('data-mode'), true); el.amountInput.focus(); }
  });
  el.amountInput.addEventListener('input', function () { sanitizeInput(); el.sheetError.hidden = true; updatePreview(); });
  el.amountInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  el.noteInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  el.sheetSave.addEventListener('click', commit);
  el.sheetCancel.addEventListener('click', closeSheet);
  el.backdrop.addEventListener('click', function () {
    if (el.actionSheet.classList.contains('is-open')) closeActions(); else closeSheet();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (el.actionSheet.classList.contains('is-open')) closeActions();
    else if (el.sheet.classList.contains('is-open')) closeSheet();
  });

  function togglePrivacy() { state.privacy = !state.privacy; save(); render(); }
  el.privacyBtn.addEventListener('click', togglePrivacy);
  el.privacyBtnSmall.addEventListener('click', togglePrivacy);

  el.clearHistoryBtn.addEventListener('click', openActions);
  el.cancelClear.addEventListener('click', closeActions);
  el.confirmClear.addEventListener('click', function () {
    state.history = []; historyShown = 10; save(); render(); closeActions(); toast('Historia wyczyszczona');
  });

  // Mały tytuł w pasku po przewinięciu dużego tytułu
  function onScroll() { el.navbar.classList.toggle('is-scrolled', window.scrollY > 36); }
  window.addEventListener('scroll', onScroll, { passive: true });

  // Odświeżaj czasy względne
  setInterval(render, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { state = load(); render(); } });

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
