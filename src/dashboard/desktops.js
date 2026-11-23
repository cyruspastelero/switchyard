// ── Desktops (Contexts tab) ───────────────────────────────────────────────────
// The "Desktops" section (one row per desktop: pick, owner, windows, Go, Close; Add desktop per screen; a batch
// close for the picked rows) and the
// desktop select on each card's meta line. Rows a context owns take a dragged window (dragdrop.js). A context's key is its ⌥N and its Desktop N; picking a key another
// context holds swaps the two. contexts.js passes its DOM helpers and act(); all text goes in through h().

(function (root) {
  'use strict';

  function seg(id) { return encodeURIComponent(String(id)); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  // GET /api/contexts `desktopList` -> view model; null when the server or the Mac app has none.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      desktops: arr(raw.desktops).filter(function (d) { return d && typeof d.number === 'number'; }).map(function (d) {
        return {
          number: d.number,
          screen: Number(d.screen) || 1,
          screenLabel: typeof d.screenLabel === 'string' ? d.screenLabel : 'Screen',
          showing: d.showing === true,
          shared: d.shared === true,
          owners: arr(d.owners).map(function (o) { return { id: String(o.id), name: String(o.name) }; }),
          windows: Number(d.windows) || 0,
          closeBlocked: typeof d.closeBlocked === 'string' ? d.closeBlocked : null,
        };
      }),
      screens: arr(raw.screens).map(function (s) {
        return { screen: Number(s.screen) || 1, label: String(s.label || 'Screen'), addBlocked: typeof s.addBlocked === 'string' ? s.addBlocked : null };
      }),
    };
  }

  root.MCDesktops = function (deps) {
    var h = deps.h, add = deps.add, button = deps.button, act = deps.act, request = deps.request, busy = deps.busy;
    var logic = root.MCContextsLogic;

    var api = {
      setKey: function (contextId, key) { return request('PATCH', '/api/contexts/' + seg(contextId), { key: key }); },
      show: function (n) { return request('POST', '/api/contexts/desktops/' + n + '/show', {}); },
      close: function (n) { return request('POST', '/api/contexts/desktops/' + n + '/close', {}); },
      add: function (screen) { return request('POST', '/api/contexts/desktops', { screen: screen }); },
    };

    function select(key, label, options, value, disabled, onChange) {
      var box = h('select', 'ctx-select ctx-key-select', null, { 'data-fk': key, 'aria-label': label });
      options.forEach(function (o) {
        var opt = h('option', null, o.label, { value: o.value });
        if (o.value === value) opt.selected = true;
        box.appendChild(opt);
      });
      if (disabled) box.disabled = true;
      box.addEventListener('change', function () { onChange(box.value); });
      return box;
    }

    function setKey(busyKey, ctx, key, count) {
      act(busyKey, function () {
        return api.setKey(ctx.id, key).then(function () { return { notice: logic.keyDoneText(ctx.name, key, count) }; });
      });
    }

    // A card's meta line. In desktop mode its "Desktop N · ⌥N" part is a select.
    function cardMeta(c, d) {
      var meta = h('div', 'ctx-card-meta ctx-status-' + c.status);
      if (d.desktopMode !== 'desktops' || !d.desktopCount) {
        meta.textContent = logic.cardMeta(c) + (c.desktopShared ? ' · shared' : '');
      } else {
        var key = 'desktopKey:' + c.id;
        add(meta, select(key, 'Desktop for ' + c.name, logic.keyOptions(d.contexts, c, d.desktopCount),
          c.key == null ? '' : String(c.key), !!busy[key], function (v) { setKey(key, c, v ? Number(v) : null, d.desktopCount); }),
        h('span', null, logic.statusWord(c)));
      }
      if (d.activeContextId === c.id) meta.appendChild(h('i', 'ctx-onscreen', null, { title: 'On screen', 'aria-label': 'On screen', role: 'img' }));
      return meta;
    }

    function ownerCell(row, d) {
      if (row.shared || row.number > 9 || !d.contexts.length) return h('span', 'ctx-desktop-owner', logic.desktopOwnerText(row));
      var key = 'desktopOwner:' + row.number;
      var current = row.owners[0] || null;
      return select(key, 'Project on Desktop ' + row.number, logic.desktopOwnerOptions(row, d.contexts, d.desktopCount),
        current ? current.id : '', !!busy[key], function (v) {
          var ctx = v ? d.contexts.filter(function (c) { return c.id === v; })[0] : current;
          if (ctx) setKey(key, ctx, v ? row.number : null, d.desktopCount);
        });
    }

    // Desktops picked for a batch close; kept across renders, dropped once closed or gone.
    var picked = {};
    var BATCH = 'desktopBatch';
    function pickedNumbers() { return Object.keys(picked).map(Number); }

    function pickBox(row, control, onPick) {
      var box = h('input', 'ctx-desktop-pick', null, { type: 'checkbox', 'data-fk': 'desktopPick:' + row.number, 'aria-label': 'Select Desktop ' + row.number });
      box.checked = !!picked[row.number];
      if (!control || !!row.closeBlocked || !!busy[BATCH]) box.disabled = true;
      if (row.closeBlocked) box.title = row.closeBlocked;
      box.addEventListener('change', function () {
        if (box.checked) picked[row.number] = true; else delete picked[row.number];
        onPick();
      });
      // The label is the hit area (44px on a phone); the box itself stays small.
      return add(h('label', 'ctx-desktop-pick-hit'), box);
    }

    // One shape for every row: pick, name, owner, meta, showing, Go/Close. A blocked Close says why on hover.
    function desktopRow(row, d, control, onPick) {
      var li = h('li', 'ctx-desktop-row' + (row.showing ? ' showing' : ''));
      var name = 'Desktop ' + row.number;
      var go = 'desktopShow:' + row.number, close = 'desktopClose:' + row.number;
      add(li, pickBox(row, control, onPick), h('span', 'ctx-layout-name', name), ownerCell(row, d),
        h('span', 'ctx-muted ctx-desktop-meta', logic.desktopMeta(row)),
        h('span', 'ctx-desktop-showing', row.showing ? 'Showing' : ''),
        h('span', 'ctx-desktop-acts'));
      if (deps.drag) deps.drag.target(li, row);
      add(li.lastChild,
        button(busy[go] ? 'Going…' : 'Go', '', go, function () {
          act(go, function () { return api.show(row.number); }, name);
        }, !control || !!busy[go]),
        button(busy[close] ? 'Closing…' : 'Close', '', close, function () {
          if (!root.confirm(logic.closeDesktopConfirm(row.number))) return;
          act(close, function () { return api.close(row.number); }, name);
        }, !control || !!row.closeBlocked || !!busy[close] || !!busy[BATCH], row.closeBlocked || ''));
      return li;
    }

    function fetchList() {
      return request('GET', '/api/contexts').then(function (raw) { return normalize(raw && raw.desktopList); });
    }

    // Closes one desktop and waits for the Mac app to report one desktop fewer. The close route only queues the
    // command, so each row is re-read first: a desktop the server now blocks is skipped, like a single close.
    function closeOne(n, tally) {
      return fetchList().then(function (list) {
        var row = list && list.desktops.filter(function (r) { return r.number === n; })[0];
        if (!row || row.closeBlocked) { tally.skipped++; return null; }
        var before = list.desktops.length;
        return api.close(n).then(function () {
          return logic.pollUntil(function () {
            return fetchList().then(function (l) { return !!l && l.desktops.length < before; });
          }, 500, 20000);
        }).then(function (gone) {
          if (!gone) throw new Error('Desktop ' + n + ' did not close in time');
          tally.closed++;
          delete picked[n];
          return null;
        });
      });
    }

    function runBatch(plan) {
      var tally = { closed: 0, skipped: plan.skipped.length };
      return plan.close.reduce(function (p, n) {
        return p.then(function () { return closeOne(n, tally); });
      }, Promise.resolve()).then(function () {
        picked = {};
        return { notice: logic.closeBatchDoneText(tally.closed, tally.skipped) };
      }, function (err) {
        throw new Error(logic.closeBatchDoneText(tally.closed, tally.skipped) + '. Stopped: ' + (err.message || 'that did not work.'));
      });
    }

    function batchBar(list, control) {
      var bar = h('div', 'ctx-desktop-batch');
      var label = h('span', 'ctx-muted');
      var go = button('', '', BATCH, function () {
        var plan = logic.closePlan(list.desktops, pickedNumbers());
        if (!plan.close.length || !root.confirm(logic.closeBatchConfirm(plan))) return;
        act(BATCH, function () { return runBatch(plan); });
      });
      function update() {
        var plan = logic.closePlan(list.desktops, pickedNumbers());
        var count = pickedNumbers().length;
        label.textContent = count ? count + ' selected' : 'Select desktops to close several at once';
        go.textContent = busy[BATCH] ? 'Closing…' : logic.closeBatchLabel(plan);
        go.disabled = !control || !plan.close.length || !!busy[BATCH];
        go.title = plan.skipped.map(function (s) { return s.reason; }).join('\n');
      }
      update();
      add(bar, label, go);
      return { el: bar, update: update };
    }

    function section(d, control) {
      var list = d.desktopList;
      if (!list || !list.desktops.length) return null;
      pickedNumbers().forEach(function (n) {
        if (!list.desktops.some(function (r) { return r.number === n; })) delete picked[n];
      });
      var box = h('div', 'ctx-foot ctx-layouts ctx-desktops');
      var head = h('div', 'ctx-toggle');
      head.appendChild(h('span', 'ctx-toggle-name', 'Desktops'));
      if (deps.drag) head.appendChild(h('span', 'ctx-muted ctx-drop-hint', 'Drop a window on a context’s desktop to move it there'));
      list.screens.forEach(function (s) {
        var key = 'desktopAdd:' + s.screen;
        var label = list.screens.length > 1 ? 'Add to ' + s.label : 'Add desktop';
        head.appendChild(button(busy[key] ? 'Adding…' : label, '', key, function () {
          act(key, function () { return api.add(s.screen); }, s.label);
        }, !control || !!s.addBlocked || !!busy[key], s.addBlocked || 'Add a desktop at the end of this screen’s row'));
      });
      box.appendChild(head);
      var bar = batchBar(list, control);
      var ul = h('ul', 'ctx-layout-list');
      list.desktops.forEach(function (row) { ul.appendChild(desktopRow(row, d, control, bar.update)); });
      add(box, ul, bar.el);
      return box;
    }

    return { section: section, cardMeta: cardMeta };
  };
  root.MCDesktops.normalize = normalize;
})(window);
