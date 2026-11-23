// ── Desktops (Contexts tab) ───────────────────────────────────────────────────
// The "Desktops" section (one tile per desktop: click to go, drag its project chip onto another tile to swap, drop a
// window on an owned tile to move it there (dragdrop.js); Select mode ticks tiles for one batch close; a "+ Add" tile
// per screen) and the desktop select on each card's meta line. A context's key is its ⌥N and its Desktop N; picking a key another
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

    // Desktops picked for a batch close; kept across renders, dropped once closed or gone.
    var picked = {};
    var selecting = false;
    var BATCH = 'desktopBatch';
    function pickedNumbers() { return Object.keys(picked).map(Number); }

    // A project chip being dragged between tiles (window drags are dragdrop.js's and never set this).
    var swapping = null;
    function tiles() { return Array.prototype.slice.call(document.querySelectorAll('.ctx-desk-tile')); }
    function endSwap() {
      if (!swapping) return;
      swapping = null;
      document.body.classList.remove('ctx-swapping');
      tiles().forEach(function (t) { t.classList.remove('swap-ok', 'swap-off', 'swap-over'); t.removeAttribute('data-drop-note'); });
      if (deps.editing) deps.editing(false);
    }

    // The owner of a tile as a chip in its context colour. Dragging it onto another tile swaps the two projects.
    function ownerChip(row, d) {
      if (row.shared) return h('span', 'ctx-desk-owner ctx-muted', 'Shared');
      var owner = row.owners[0];
      if (!owner) return h('span', 'ctx-desk-owner ctx-muted', 'Free');
      var ctx = d.contexts.filter(function (c) { return c.id === owner.id; })[0] || { id: owner.id, name: owner.name, key: row.number };
      var chip = h('span', 'ctx-desk-owner ctx-desk-chip', null, {
        draggable: row.number <= 9 ? 'true' : 'false', title: 'Drag onto another desktop to swap',
      });
      add(chip, deps.dot ? deps.dot(ctx.color) : h('i', 'ctx-dot'), h('span', 'ctx-desk-owner-name', logic.desktopOwnerText(row)));
      chip.addEventListener('dragstart', function (e) {
        e.stopPropagation();
        swapping = { id: ctx.id, name: ctx.name, key: ctx.key != null ? ctx.key : row.number };
        var dt = e.dataTransfer;
        dt.effectAllowed = 'move';
        dt.setData('text/plain', ctx.name); // Firefox starts no drag without data
        if (deps.editing) deps.editing(true);
        document.body.classList.add('ctx-swapping');
        tiles().forEach(function (t) {
          var r = JSON.parse(t.getAttribute('data-desk'));
          var v = logic.swapTarget(swapping, r);
          t.classList.add(v.ok ? 'swap-ok' : 'swap-off');
          t.setAttribute('data-drop-note', v.note);
        });
      });
      chip.addEventListener('dragend', endSwap);
      return chip;
    }

    // Swap targets. Added before dragdrop.js's window targets on the same tile; each ignores the other's drags.
    function swapTargetOn(tile, row, d) {
      function verdict() { return swapping ? logic.swapTarget(swapping, row) : null; }
      function accept(e) {
        var v = verdict();
        if (!v || !v.ok) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tiles().forEach(function (t) { if (t !== tile) t.classList.remove('swap-over'); });
        tile.classList.add('swap-over');
      }
      tile.addEventListener('dragenter', accept);
      tile.addEventListener('dragover', accept);
      tile.addEventListener('drop', function (e) {
        var v = verdict();
        if (!v || !v.ok) return;
        e.preventDefault();
        var ctx = swapping;
        endSwap();
        setKey('desktopKey:' + ctx.id, ctx, row.number, d.desktopCount);
      });
    }

    function pickBox(row, control, onPick) {
      var box = h('input', 'ctx-desktop-pick', null, { type: 'checkbox', 'data-fk': 'desktopPick:' + row.number, 'aria-label': 'Select Desktop ' + row.number });
      box.checked = !!picked[row.number];
      if (!control || !!row.closeBlocked || !!busy[BATCH]) box.disabled = true;
      if (row.closeBlocked) box.title = row.closeBlocked;
      box.addEventListener('change', function () {
        if (box.checked) picked[row.number] = true; else delete picked[row.number];
        onPick();
      });
      return box;
    }

    // One tile per desktop, the same parts on every tile: name (Go), on-screen mark or select box, owner, windows.
    // Clicking the tile goes there; in Select mode it ticks the box instead.
    function desktopTile(row, d, control, onPick, multiScreen, built) {
      var tile = h('li', 'ctx-desktop-row ctx-desk-tile' + (row.showing ? ' showing' : '') + (row.closeBlocked ? ' blocked' : ''),
        null, { 'data-desk': JSON.stringify({ number: row.number, shared: row.shared, owners: row.owners }) });
      var name = 'Desktop ' + row.number, go = 'desktopShow:' + row.number;
      var goBtn = h('button', 'ctx-desk-go', name, { type: 'button', 'data-fk': go, title: row.showing ? 'On screen now' : 'Go to ' + name });
      if (!control || busy[go]) goBtn.disabled = true;
      var box = pickBox(row, control, onPick);
      built.push({ tile: tile, box: box, blocked: row.closeBlocked });
      // In Select mode a click ticks the box (as its change event would); otherwise it goes to the desktop.
      function goOrPick() {
        if (selecting) {
          if (box.disabled) return;
          box.checked = !box.checked;
          if (box.checked) picked[row.number] = true; else delete picked[row.number];
          onPick();
          return;
        }
        if (!goBtn.disabled) act(go, function () { return api.show(row.number); }, name);
      }
      goBtn.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        goOrPick();
      });
      var mark = row.showing ? h('span', 'ctx-desk-showing', 'On screen') : h('span', 'ctx-desk-showing');
      var head = add(h('div', 'ctx-desk-head'), goBtn, mark, box);
      add(tile, head, ownerChip(row, d), h('span', 'ctx-muted ctx-desk-meta', logic.desktopMeta(row, multiScreen)));
      tile.addEventListener('click', function (e) {
        var t = e && e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON')) return;
        goOrPick();
      });
      swapTargetOn(tile, row, d);
      if (deps.drag) deps.drag.target(tile, row);
      return tile;
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
        act(BATCH, function () { return runBatch(plan).then(function (res) { selecting = false; return res; }); });
      });
      function update() {
        var plan = logic.closePlan(list.desktops, pickedNumbers());
        var count = pickedNumbers().length;
        label.textContent = count ? count + ' selected' : 'Tick the desktops to close';
        go.textContent = busy[BATCH] ? 'Closing\u2026' : logic.closeBatchLabel(plan);
        go.disabled = !control || !plan.close.length || !!busy[BATCH];
        go.title = plan.skipped.map(function (s) { return s.reason; }).join('\n');
      }
      update();
      add(bar, label, go);
      return { el: bar, update: update };
    }

    function addTile(s, list, control) {
      var key = 'desktopAdd:' + s.screen;
      var label = list.screens.length > 1 ? '+ Add to ' + s.label : '+ Add desktop';
      var b = h('button', 'ctx-desk-add', busy[key] ? 'Adding\u2026' : label, { type: 'button', 'data-fk': key, title: s.addBlocked || 'Add a desktop at the end of this screen\u2019s row' });
      if (!control || !!s.addBlocked || !!busy[key]) b.disabled = true;
      b.addEventListener('click', function () { act(key, function () { return api.add(s.screen); }, s.label); });
      return add(h('li', 'ctx-desk-add-slot'), b);
    }

    // Select mode on or off without a re-render: boxes follow `picked` (Done clears them), and a tile that can't
    // close says why on hover, since its box is the only other place that reason lives.
    function markSelecting(built) {
      built.forEach(function (b) {
        b.box.checked = !!picked[Number(b.box.getAttribute('data-fk').split(':')[1])];
        b.tile.title = selecting && b.blocked ? b.blocked : '';
      });
    }

    function section(d, control) {
      var list = d.desktopList;
      if (!list || !list.desktops.length) return null;
      pickedNumbers().forEach(function (n) {
        if (!list.desktops.some(function (r) { return r.number === n; })) delete picked[n];
      });
      var closable = list.desktops.some(function (r) { return !r.closeBlocked; });
      if (!closable) { selecting = false; picked = {}; }
      var box = h('div', 'ctx-foot ctx-layouts ctx-desktops' + (selecting ? ' selecting' : ''));
      var head = h('div', 'ctx-toggle');
      head.appendChild(h('span', 'ctx-toggle-name', 'Desktops'));
      head.appendChild(h('span', 'ctx-muted ctx-desk-hint', selecting
        ? 'Click desktops to tick them'
        : 'Click to go \u00B7 drag a project onto another desktop to swap \u00B7 drop a window to move it'));
      if (closable) {
        head.appendChild(button(selecting ? 'Done' : 'Select', '', 'desktopSelect', function () {
          selecting = !selecting;
          if (!selecting) picked = {};
          if (selecting) box.classList.add('selecting'); else box.classList.remove('selecting');
          markSelecting(built);
          bar.update();
        }, !control, 'Pick desktops to close several at once'));
      }
      box.appendChild(head);
      var bar = batchBar(list, control);
      var multi = list.screens.length > 1;
      var built = [];
      var ul = h('ul', 'ctx-desk-grid');
      list.desktops.forEach(function (row) { ul.appendChild(desktopTile(row, d, control, bar.update, multi, built)); });
      markSelecting(built);
      list.screens.forEach(function (s) { ul.appendChild(addTile(s, list, control)); });
      add(box, ul, bar.el);
      return box;
    }

    return { section: section, cardMeta: cardMeta };
  };
  root.MCDesktops.normalize = normalize;
})(window);
