// ── Drag a window onto a desktop row (Contexts tab) ─────────────────────────
// Window rows (Unsorted and on cards) drag onto the Desktops rows. A drop assigns the window to the context that
// owns the row, which also carries it there, then offers Undo for a few seconds. Only rows one context owns take
// a drop: the shared desktop and free desktops have no owner to assign to. The Assign and Move pickers stay the
// keyboard way to do the same. The rules and words are pure and unit-tested (test/dashboard/dragdrop.test.ts).

(function (root) {
  'use strict';

  // { ok, owner, reason }: whether a window from `fromContextId` (null: Unsorted) can drop on this row.
  function dropTarget(row, fromContextId) {
    if (row.shared) return { ok: false, owner: null, reason: 'The shared desktop has no context to assign to' };
    var owner = row.owners.length === 1 ? row.owners[0] : null;
    if (!owner) return { ok: false, owner: null, reason: 'No context owns this desktop' };
    if (owner.id === fromContextId) return { ok: false, owner: owner, reason: 'Already in ' + owner.name };
    return { ok: true, owner: owner, reason: '' };
  }

  function undoPlan(fromContextId) {
    return fromContextId ? { action: 'assign', contextId: fromContextId } : { action: 'unassign' };
  }

  function dropText(result, ownerName) {
    var text = 'Moved to ' + ownerName;
    return result && result.moving && typeof result.desktop === 'number' ? text + ' · Desktop ' + result.desktop : text;
  }

  function undoText(fromName) { return fromName ? 'Moved back to ' + fromName : 'Back in Unsorted'; }

  var logic = { dropTarget: dropTarget, undoPlan: undoPlan, dropText: dropText, undoText: undoText };
  if (typeof module === 'object' && module.exports) { module.exports = logic; return; }

  // contexts.js passes its DOM helpers, act(), request(), data() and editing(on), which holds re-renders while a
  // drag is in flight (a re-render would remove the row being dragged).
  root.MCDragDrop = function (deps) {
    var h = deps.h, add = deps.add, act = deps.act, request = deps.request;
    var drag = null; // { windowKey, from: { id, name } | null }

    function assign(windowKey, contextId) {
      return request('POST', '/api/contexts/assign', { windowKey: windowKey, contextId: contextId });
    }
    function unassign(windowKey) { return request('POST', '/api/contexts/unassign', { windowKey: windowKey }); }

    function rows() { return Array.prototype.slice.call(document.querySelectorAll('.ctx-desktop-row[data-drop]')); }

    function finish() {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('ctx-dragging');
      rows().forEach(function (li) { li.classList.remove('drop-ok', 'drop-off', 'drop-over'); li.removeAttribute('title'); });
      deps.editing(false);
    }

    // A small chip with the app and title, so the drag shows what moves, not a slice of the row.
    function ghost(w, label) {
      var chip = add(h('div', 'ctx-drag-ghost'), h('span', 'ctx-drag-app', w.app), h('span', null, label));
      document.body.appendChild(chip);
      setTimeout(function () { if (chip.parentNode) chip.parentNode.removeChild(chip); }, 0);
      return chip;
    }

    // A window row. `from` is the card's context, or null for Unsorted.
    function source(li, w, from, label) {
      var d = deps.data();
      if (!d || !d.desktopList || !d.desktopList.desktops.length) return;
      li.setAttribute('draggable', 'true');
      li.classList.add('ctx-draggable');
      li.addEventListener('dragstart', function (e) {
        drag = { windowKey: w.key, from: from };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', label);
        if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(ghost(w, label), 12, 12);
        deps.editing(true);
        document.body.classList.add('ctx-dragging');
        rows().forEach(function (row) {
          var t = dropTarget(JSON.parse(row.getAttribute('data-drop')), from ? from.id : null);
          row.classList.add(t.ok ? 'drop-ok' : 'drop-off');
          row.title = t.ok ? 'Drop to move it to ' + t.owner.name : t.reason;
        });
      });
      li.addEventListener('dragend', finish);
    }

    function drop(row, t) {
      var windowKey = drag.windowKey, from = drag.from;
      finish();
      var plan = undoPlan(from ? from.id : null);
      act('drop:' + windowKey, function () {
        return assign(windowKey, t.owner.id).then(function (res) {
          return {
            notice: dropText(res, t.owner.name),
            followUp: {
              label: 'Undo', key: 'undoDrop:' + windowKey, toast: true,
              run: function () {
                var back = plan.action === 'assign' ? assign(windowKey, plan.contextId) : unassign(windowKey);
                return back.then(function () { return { notice: undoText(from ? from.name : null) }; });
              },
            },
          };
        });
      });
    }

    // A Desktops row. It carries its owners so a drag can mark it without the view model.
    function target(li, row) {
      li.setAttribute('data-drop', JSON.stringify({ number: row.number, shared: row.shared, owners: row.owners }));
      function check() { return drag ? dropTarget(row, drag.from ? drag.from.id : null) : null; }
      li.addEventListener('dragover', function (e) {
        var t = check();
        if (!t || !t.ok) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        li.classList.add('drop-over');
      });
      li.addEventListener('dragleave', function (e) {
        if (!e.relatedTarget || !li.contains(e.relatedTarget)) li.classList.remove('drop-over');
      });
      li.addEventListener('drop', function (e) {
        var t = check();
        if (!t || !t.ok) return;
        e.preventDefault();
        drop(row, t);
      });
    }

    return { source: source, target: target };
  };
})(typeof window !== 'undefined' ? window : this);
