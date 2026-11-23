// ── New context dialog (Contexts tab) ────────────────────────────────────────
// "New context" in the Contexts header: name it, pick a desktop (the next free one by default), tick the windows
// that belong to it. Create makes the context, moves it to the chosen desktop if that is not the default, then
// assigns each picked window in turn (each assign carries the window to the context's desktop). Unpicked windows
// stay where they are. A modal <dialog>: the browser traps focus and Esc closes it. The grouping, desktop choice
// and words are pure and unit-tested (test/dashboard/new-context.test.ts); all text goes in through h().

(function (root) {
  'use strict';

  var shared = typeof module === 'object' && module.exports ? require('./contexts-logic.js') : root.MCContextsLogic;

  function matches(w, contextName, q) {
    if (!q) return true;
    return [w.app, w.title, w.name, contextName || ''].join(' ').toLowerCase().indexOf(q) !== -1;
  }

  // [{ id, label, windows: [{ window, from }] }]: Unsorted windows by app (first-seen order), then one group per
  // context holding windows, each window marked with the context it would leave.
  function windowGroups(unsorted, contexts, query) {
    var q = String(query || '').trim().toLowerCase();
    var out = [];
    var byApp = {};
    unsorted.forEach(function (w) {
      if (!matches(w, null, q)) return;
      var g = byApp[w.app];
      if (!g) { g = byApp[w.app] = { id: 'app:' + w.app, label: w.app, windows: [] }; out.push(g); }
      g.windows.push({ window: w, from: null });
    });
    contexts.forEach(function (c) {
      var wins = (c.windows || []).filter(function (w) { return matches(w, c.name, q); });
      if (!wins.length) return;
      out.push({ id: 'ctx:' + c.id, label: 'In ' + c.name, windows: wins.map(function (w) { return { window: w, from: { id: c.id, name: c.name } }; }) });
    });
    return out;
  }

  // The key the server gives a new context: the lowest of 1-9 no context holds.
  function nextFreeKey(contexts) {
    var used = {};
    contexts.forEach(function (c) { if (c.key != null) used[c.key] = true; });
    for (var k = 1; k <= 9; k++) if (!used[k]) return k;
    return null;
  }

  // The desktop select: the card's key options, the next free one marked and picked. null without real desktops.
  function desktopChoice(contexts, desktopCount) {
    if (desktopCount == null) return null;
    var key = nextFreeKey(contexts);
    var value = key == null ? '' : String(key);
    var options = shared.keyOptions(contexts, { id: '', key: key }, desktopCount).map(function (o) {
      // Only a real desktop is "next free"; with none left the default is the shared desktop, said once.
      return key != null && o.value === value ? { value: o.value, label: o.label + ' (next free)' } : o;
    });
    return { options: options, value: value };
  }

  function createdText(name, assigned) {
    if (!assigned) return 'Created ' + name;
    return 'Created ' + name + ' with ' + assigned + (assigned === 1 ? ' window' : ' windows');
  }

  var logic = { windowGroups: windowGroups, nextFreeKey: nextFreeKey, desktopChoice: desktopChoice, createdText: createdText };
  if (typeof module === 'object' && module.exports) { module.exports = logic; return; }

  // contexts.js passes its DOM helpers, act(), request(), data() and appIcon(w).
  root.MCNewContext = function (deps) {
    var h = deps.h, add = deps.add, button = deps.button, request = deps.request;
    var dialog = null, opener = null;

    // Closes the dialog and puts focus back on whatever opened it (the header button).
    function close() {
      if (!dialog) return;
      var d = dialog;
      dialog = null;
      if (d.open) d.close();
      if (d.parentNode) d.parentNode.removeChild(d);
      if (opener && opener.focus) opener.focus();
      opener = null;
    }

    // Runs after the context exists; a retry after a failure skips what is already done.
    function create(state, name, desktop) {
      var made = state.id ? Promise.resolve(state.row) : request('POST', '/api/contexts', { name: name }).then(function (row) {
        if (!row || !row.id) throw new Error('The server did not return the new context.');
        state.id = String(row.id);
        state.row = row;
        return row;
      });
      return made.then(function (row) {
        if (desktop === null || desktop === (row.key == null ? '' : String(row.key))) return null;
        return request('PATCH', '/api/contexts/' + encodeURIComponent(state.id), { key: desktop ? Number(desktop) : null })
          .then(function (updated) { state.row = updated || row; });
      }).then(function () {
        var keys = Object.keys(state.picked).filter(function (k) { return !state.done[k]; });
        return keys.reduce(function (p, key) {
          return p.then(function () {
            return request('POST', '/api/contexts/assign', { windowKey: key, contextId: state.id }).then(function () { state.done[key] = true; });
          });
        }, Promise.resolve());
      });
    }

    function windowOption(item, state, onChange) {
      var w = item.window;
      var id = 'nc-w-' + Object.keys(state.ids).length;
      state.ids[id] = true;
      var box = h('input', 'nc-check', null, { type: 'checkbox', id: id });
      box.checked = !!state.picked[w.key];
      box.addEventListener('change', function () {
        if (box.checked) state.picked[w.key] = true; else delete state.picked[w.key];
        onChange();
      });
      var label = add(h('label', 'nc-win', null, { for: id }), deps.appIcon(w), h('span', 'nc-win-title', shared.windowLabel(w)));
      if (item.from) label.appendChild(h('span', 'nc-win-from', 'in ' + item.from.name));
      return add(h('li', 'nc-item'), box, label);
    }

    function open() {
      if (dialog) return;
      var d = deps.data();
      if (!d) return;
      opener = document.activeElement;
      var state = { picked: {}, done: {}, ids: {}, id: null, row: null };
      var choice = d.desktopMode === 'desktops' ? desktopChoice(d.contexts, d.desktopCount) : null;
      dialog = h('dialog', 'nc-dialog', null, { 'aria-labelledby': 'nc-title' });
      var form = h('form', 'nc-form', null, { method: 'dialog' });
      var name = h('input', 'ctx-input nc-input', null, { type: 'text', id: 'nc-name', maxlength: '60', required: '', autocomplete: 'off' });
      var desk = null;
      if (choice) {
        desk = h('select', 'ctx-select', null, { id: 'nc-desktop' });
        choice.options.forEach(function (o) {
          var opt = h('option', null, o.label, { value: o.value });
          if (o.value === choice.value) opt.selected = true;
          desk.appendChild(opt);
        });
      }
      var search = h('input', 'ctx-input nc-input', null, { type: 'search', id: 'nc-search', placeholder: 'Search windows', 'aria-controls': 'nc-list' });
      var list = h('div', 'nc-list', null, { id: 'nc-list' });
      var count = h('span', 'ctx-muted nc-count', '', { 'aria-live': 'polite' });
      var error = h('div', 'ctx-error nc-error', null, { role: 'alert' });
      error.hidden = true;
      var submit = button('Create', 'primary', 'nc-create', function () {});
      submit.type = 'submit';

      function updateCount() {
        var n = Object.keys(state.picked).length;
        count.textContent = n ? n + (n === 1 ? ' window picked' : ' windows picked') : 'No windows picked';
      }
      function drawList() {
        while (list.firstChild) list.removeChild(list.firstChild);
        state.ids = {};
        var unsorted = deps.isSystemWindow ? d.unsorted.filter(function (w) { return !deps.isSystemWindow(w); }) : d.unsorted;
        var groups = windowGroups(unsorted, d.contexts, search.value);
        if (!groups.length) list.appendChild(h('p', 'ctx-muted nc-empty', search.value ? 'No windows match.' : 'No open windows.'));
        groups.forEach(function (g, i) {
          var head = h('div', 'nc-group-title', g.label, { id: 'nc-g-' + i });
          var ul = h('ul', 'nc-group', null, { role: 'group', 'aria-labelledby': 'nc-g-' + i });
          g.windows.forEach(function (item) { ul.appendChild(windowOption(item, state, updateCount)); });
          add(list, head, ul);
        });
      }

      add(form,
        h('h2', 'nc-title', 'New context', { id: 'nc-title' }),
        add(h('div', 'nc-field'), h('label', 'nc-label', 'Name', { for: 'nc-name' }), name),
        desk ? add(h('div', 'nc-field'), h('label', 'nc-label', 'Desktop', { for: 'nc-desktop' }), desk) : null,
        add(h('div', 'nc-field'), h('label', 'nc-label', 'Windows', { for: 'nc-search' }), search, list),
        error,
        add(h('div', 'nc-foot'), count, button('Cancel', '', 'nc-cancel', close), submit));
      dialog.appendChild(form);

      search.addEventListener('input', drawList);
      search.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
      dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
      var self = dialog;
      dialog.addEventListener('close', function () { if (dialog === self) close(); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = name.value.trim();
        if (!text) { name.focus(); return; }
        submit.disabled = true;
        submit.textContent = 'Creating…';
        error.hidden = true;
        create(state, text, desk ? desk.value : null).then(function () {
          var assigned = Object.keys(state.done).length;
          close();
          deps.act('newContext', function () { return Promise.resolve({ notice: createdText(text, assigned) }); });
        }, function (err) {
          submit.disabled = false;
          submit.textContent = 'Try again';
          if (state.id) name.readOnly = true;
          error.textContent = (state.id ? createdText(text, Object.keys(state.done).length) + '. ' : '') + (err.message || 'That did not work.');
          error.hidden = false;
        });
      });

      drawList();
      updateCount();
      document.body.appendChild(dialog);
      dialog.showModal();
      name.focus();
    }

    return { open: open };
  };
})(typeof window !== 'undefined' ? window : this);
