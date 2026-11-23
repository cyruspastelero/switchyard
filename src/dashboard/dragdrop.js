// ── Drag a window onto a desktop row, a context card or Unsorted (Contexts tab) ──────────────────────
// Window rows (Unsorted and on cards) drag onto three kinds of target. A Desktops row or a context card assigns the
// window to that context, which also carries it to the context's desktop; the Unsorted box unassigns it. Every drop
// commits at once and offers Undo for 10 s. Desktop rows take a drop only when one context owns them, a card refuses
// the window it already holds, Unsorted refuses a window already unsorted. Targets never take focus: the Assign and
// Move pickers stay the keyboard (and touch) way to do the same. Rules and words are pure and unit-tested
// (test/dashboard/dragdrop.test.ts).

(function (root) {
  'use strict';

  var ASSIGN = '/api/contexts/assign', UNASSIGN = '/api/contexts/unassign';

  function open(owner) { return { ok: true, owner: owner, name: owner ? owner.name : 'Unsorted', reason: '' }; }
  function shut(owner, reason) { return { ok: false, owner: owner, name: owner ? owner.name : 'Unsorted', reason: reason }; }

  // { ok, owner, name, reason }: whether a window from `fromContextId` (null: Unsorted) can drop on `spec`.
  // spec is a Desktops row ({ number, shared, owners }), { kind: 'card', id, name } or { kind: 'unsorted' }.
  function dropTarget(spec, fromContextId) {
    if (spec.kind === 'unsorted') return fromContextId ? open(null) : shut(null, 'Already in Unsorted');
    if (spec.kind === 'card') {
      var ctx = { id: spec.id, name: spec.name };
      return ctx.id === fromContextId ? shut(ctx, 'Already in ' + ctx.name) : open(ctx);
    }
    if (spec.shared) return shut(null, 'The shared desktop has no context to assign to');
    var owner = spec.owners.length === 1 ? spec.owners[0] : null;
    if (!owner) return shut(null, 'No context owns this desktop');
    if (owner.id === fromContextId) return shut(owner, 'Already in ' + owner.name);
    return open(owner);
  }

  // The POST a drop makes: assign to the target's context, or unassign for Unsorted.
  function dropRequest(windowKey, target) {
    return target.owner
      ? { path: ASSIGN, body: { windowKey: windowKey, contextId: target.owner.id } }
      : { path: UNASSIGN, body: { windowKey: windowKey } };
  }

  function undoPlan(fromContextId) {
    return fromContextId ? { action: 'assign', contextId: fromContextId } : { action: 'unassign' };
  }

  // The POST Undo makes: back to the context it came from, or back to Unsorted.
  function undoRequest(windowKey, fromContextId) {
    return dropRequest(windowKey, { owner: fromContextId ? { id: fromContextId } : null });
  }

  // What a target says while a drag is on: the invite, or why it refuses.
  function targetNote(target) { return target.ok ? 'Drop to move it to ' + target.name : target.reason; }

  function dropText(result, ownerName) {
    var text = 'Moved to ' + ownerName;
    return result && result.moving && typeof result.desktop === 'number' ? text + ' · Desktop ' + result.desktop : text;
  }

  function undoText(fromName) { return fromName ? 'Moved back to ' + fromName : 'Back in Unsorted'; }

  var logic = { dropTarget: dropTarget, dropRequest: dropRequest, undoPlan: undoPlan, undoRequest: undoRequest,
    targetNote: targetNote, dropText: dropText, undoText: undoText };
  if (typeof module === 'object' && module.exports) { module.exports = logic; return; }

  // contexts.js passes its DOM helpers, act(), request() and editing(on), which holds re-renders while a drag is in
  // flight (a re-render would remove the row being dragged). Every way a drag ends (drop, Esc, a drop outside the
  // window or on nothing) fires dragend, which releases the hold; the page listens too, in case the row is gone.
  root.MCDragDrop = function (deps) {
    var h = deps.h, add = deps.add, act = deps.act, request = deps.request;
    var drag = null; // { windowKey, from: { id, name } | null }
    var over = null; // the target under the pointer

    function targets() { return Array.prototype.slice.call(document.querySelectorAll('[data-drop]')); }
    function check(el) {
      return drag ? dropTarget(JSON.parse(el.getAttribute('data-drop')), drag.from ? drag.from.id : null) : null;
    }

    function hover(el) {
      if (over === el) return;
      if (over) over.classList.remove('drop-over');
      over = el;
      if (el) el.classList.add('drop-over');
    }

    function finish() {
      if (!drag) return;
      drag = null;
      over = null;
      document.body.classList.remove('ctx-dragging');
      targets().forEach(function (el) {
        el.classList.remove('drop-ok', 'drop-off', 'drop-over');
        el.removeAttribute('title');
        el.removeAttribute('data-drop-note');
      });
      deps.editing(false);
    }

    if (document.addEventListener) {
      document.addEventListener('dragend', finish, true);
      // Leaving a target for a spot that is none: Safari gives dragleave no relatedTarget, so track it here.
      document.addEventListener('dragover', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-drop]') : null;
        if (over && t !== over) hover(null);
      }, true);
    }

    // A small chip with the app and title, so the drag shows what moves, not a slice of the row.
    function ghost(w, label) {
      var chip = add(h('div', 'ctx-drag-ghost'), h('span', 'ctx-drag-app', w.app), h('span', null, label));
      document.body.appendChild(chip);
      setTimeout(function () { if (chip.parentNode) chip.parentNode.removeChild(chip); }, 0);
      return chip;
    }

    // A window row. `from` is the card's context, or null for Unsorted. The grip is a grab point that is not a
    // button: Firefox starts no drag on a <button>, and the title is one.
    function source(li, w, from, label) {
      li.setAttribute('draggable', 'true');
      li.classList.add('ctx-draggable');
      li.appendChild(h('span', 'ctx-w-grip', '⠿', { 'aria-hidden': 'true' }));
      // Safari (WebKit) starts no drag from a <button> inside a draggable row; marking the title button
      // draggable itself makes the title a grab point there too. Its dragstart bubbles to the row's handler.
      // The row's children are added after this call, so mark it once the row is built.
      Promise.resolve().then(function () {
        var title = li.querySelector('button.ctx-w-text');
        if (title) title.setAttribute('draggable', 'true');
      });
      li.addEventListener('dragstart', function (e) {
        drag = { windowKey: w.key, from: from };
        over = null;
        var dt = e.dataTransfer;
        if (dt.clearData) dt.clearData(); // a drag from the app icon would carry the image's URL
        dt.effectAllowed = 'move';
        dt.setData('text/plain', label); // Firefox starts no drag without data
        if (dt.setDragImage) dt.setDragImage(ghost(w, label), 12, 12);
        deps.editing(true);
        document.body.classList.add('ctx-dragging');
        targets().forEach(function (el) {
          var note = targetNote(check(el));
          el.classList.add(check(el).ok ? 'drop-ok' : 'drop-off');
          el.title = note;
          el.setAttribute('data-drop-note', note);
        });
      });
      li.addEventListener('dragend', finish);
    }

    function drop(t) {
      var windowKey = drag.windowKey, from = drag.from;
      finish();
      var go = dropRequest(windowKey, t), back = undoRequest(windowKey, from ? from.id : null);
      act('drop:' + windowKey, function () {
        return request('POST', go.path, go.body).then(function (res) {
          return {
            notice: dropText(res, t.name),
            followUp: {
              label: 'Undo', key: 'undoDrop:' + windowKey, toast: true,
              run: function () {
                return request('POST', back.path, back.body).then(function () { return { notice: undoText(from ? from.name : null) }; });
              },
            },
          };
        });
      });
    }

    // Any drop target. It carries its spec, so a drag can mark it without the view model. No tabindex: a target
    // never joins the Tab order.
    function target(el, spec) {
      el.setAttribute('data-drop', JSON.stringify(spec));
      // Accept on dragenter as well as dragover: Safari (WebKit) drops only on a target that accepted the
      // drag when it was entered, and a quick release can come before the next dragover.
      function accept(e) {
        var t = check(el);
        if (!t || !t.ok) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        hover(el);
      }
      el.addEventListener('dragenter', accept);
      el.addEventListener('dragover', accept);
      el.addEventListener('dragleave', function (e) {
        if (e.relatedTarget && !el.contains(e.relatedTarget) && over === el) hover(null);
      });
      el.addEventListener('drop', function (e) {
        var t = check(el);
        if (!t || !t.ok) return;
        e.preventDefault();
        drop(t);
      });
    }

    return {
      source: source,
      target: function (li, row) { target(li, { number: row.number, shared: row.shared, owners: row.owners }); },
      card: function (el, c) { target(el, { kind: 'card', id: c.id, name: c.name }); },
      unsorted: function (el) { target(el, { kind: 'unsorted' }); },
    };
  };
})(typeof window !== 'undefined' ? window : this);
