// ── Tab suggestions (Contexts tab) ───────────────────────────────────────────
// Tabs sitting in one context's window whose URL belongs to another context. Rows with the same URL and target
// fold into one ("2 tabs"), and rows are grouped by target with one "Move all to X" when 2+ tabs go there.
// The grouping and words are pure and unit-tested (test/dashboard/suggestions.test.ts); all text goes in through h().

(function (root) {
  'use strict';

  function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }

  function nameOf(contexts, id) {
    var c = contexts.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : null;
  }

  function windowOwner(contexts, windowKey) {
    var c = contexts.filter(function (x) { return (x.windows || []).some(function (w) { return w.key === windowKey; }); })[0];
    return c ? c.name : null;
  }

  // [{ toContextId, toName, count, rows: [{ ids, url, title, count, fromName }] }], targets in first-seen order.
  function groups(suggestions, contexts) {
    var out = [];
    suggestions.forEach(function (s) {
      var g = out.filter(function (x) { return x.toContextId === s.toContextId; })[0];
      if (!g) {
        g = { toContextId: s.toContextId, toName: nameOf(contexts, s.toContextId) || 'another context', count: 0, rows: [] };
        out.push(g);
      }
      g.count++;
      var row = g.rows.filter(function (r) { return r.url === s.url; })[0];
      if (row) { row.ids.push(s.id); row.count++; return; }
      g.rows.push({ ids: [s.id], url: s.url, title: s.title, count: 1, fromName: windowOwner(contexts, s.fromWindowKey) });
    });
    return out;
  }

  // "2 tabs in switchyard’s window": where the tab sits now, so "belongs with X" reads as a move, not a mistake.
  function where(row) {
    var win = row.fromName ? 'in ' + row.fromName + '’s window' : 'in another context’s window';
    return (row.count > 1 ? plural(row.count, 'tab') + ' ' : '') + win;
  }

  function moveAllLabel(group) { return group.count >= 2 ? 'Move all to ' + group.toName : ''; }

  function doneText(moved, toName) { return 'Moved ' + plural(moved, 'tab') + ' to ' + toName; }

  var logic = { groups: groups, where: where, moveAllLabel: moveAllLabel, doneText: doneText };
  if (typeof module === 'object' && module.exports) { module.exports = logic; return; }

  function host(url) {
    try { return new URL(url).host; } catch (e) { return url; }
  }

  // contexts.js passes its DOM helpers, act(), request() and the busy map.
  root.MCSuggestions = function (deps) {
    var h = deps.h, add = deps.add, button = deps.button, act = deps.act, request = deps.request, busy = deps.busy;
    var shared = root.MCContextsLogic;

    function accept(id) { return request('POST', '/api/contexts/suggestions/' + encodeURIComponent(id) + '/accept', {}); }

    function stillThere(id) {
      return request('GET', '/api/contexts').then(function (raw) {
        return Array.isArray(raw && raw.suggestions) && raw.suggestions.some(function (s) { return s && String(s.id) === id; });
      });
    }

    // One accept at a time. Accept only queues the move, so wait until the suggestion is gone (the tab opened in
    // the target and closed here) before the next, so later moves find the target's window instead of opening more.
    function moveAll(ids, toName) {
      var moved = 0;
      return ids.reduce(function (p, id, i) {
        return p.then(function () {
          return accept(id).then(function () {
            moved++;
            if (i === ids.length - 1) return null;
            return shared.pollUntil(function () { return stillThere(id).then(function (on) { return !on; }); }, 500, 15000);
          });
        });
      }, Promise.resolve()).then(function () {
        return { notice: doneText(moved, toName) };
      }, function (err) {
        throw new Error((moved ? doneText(moved, toName) + '. ' : '') + (err.message || 'That did not work.'));
      });
    }

    function row(r, g, control, tip) {
      var key = 'accept:' + r.ids[0];
      var line = h('div', 'ctx-suggest-row');
      var text = h('span', 'ctx-suggest-text', null, { title: r.url });
      add(text,
        h('span', 'ctx-suggest-title', r.title || host(r.url)),
        h('span', 'ctx-muted', ' · ' + where(r) + ' · belongs with '),
        h('b', null, g.toName));
      add(line, text, button(busy[key] ? 'Moving…' : 'Move', '', 'move:' + r.ids[0], function () {
        act(key, function () { return moveAll(r.ids, g.toName); });
      }, !control || !!busy[key], tip));
      return line;
    }

    function section(d, control, tip) {
      var box = h('section', 'ctx-suggest', null, { 'aria-label': 'Tab suggestions' });
      add(box, h('div', 'ctx-section-title', 'Tabs in another context’s window'));
      groups(d.suggestions, d.contexts).forEach(function (g) {
        var label = moveAllLabel(g);
        if (label) {
          var key = 'acceptAll:' + g.toContextId;
          var ids = g.rows.reduce(function (all, r) { return all.concat(r.ids); }, []);
          var head = h('div', 'ctx-suggest-row ctx-suggest-group');
          add(head, h('span', 'ctx-suggest-text ctx-muted', plural(g.count, 'tab') + ' belong with ' + g.toName),
            button(busy[key] ? 'Moving…' : label, '', key, function () {
              act(key, function () { return moveAll(ids, g.toName); });
            }, !control || !!busy[key], tip));
          box.appendChild(head);
        }
        g.rows.forEach(function (r) { box.appendChild(row(r, g, control, tip)); });
      });
      return box;
    }

    return { section: section };
  };
})(typeof window !== 'undefined' ? window : this);
