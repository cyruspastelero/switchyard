// Small searchable picker for "Assign to…": a button that opens a filter box over a list of contexts.
// ARIA combobox (the input) + listbox; ↑↓ move, Enter picks, Esc closes, outside click closes.
// Plain JS, no build step. Text is set with textContent only.

(function () {
  'use strict';

  var seq = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // opts: { label, ariaLabel, items: [{ id, name, color, meta }], suggestedId, newLabel, disabled, fk,
  //         onPick(id), onNew(), onOpen(), onClose() }
  function create(opts) {
    var id = 'pick-' + (++seq);
    var root = el('div', 'pick');
    var btn = el('button', 'pick-btn', opts.label || 'Assign to\u2026');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (opts.ariaLabel) btn.setAttribute('aria-label', opts.ariaLabel);
    if (opts.fk) btn.setAttribute('data-fk', opts.fk);
    btn.disabled = !!opts.disabled;
    root.appendChild(btn);

    // Suggested context first, the rest in the order given, "New context…" last.
    var items = opts.items.slice().sort(function (a, b) {
      return (b.id === opts.suggestedId) - (a.id === opts.suggestedId);
    });
    var pop = null, input = null, list = null, shown = [], active = 0;

    function close(refocus) {
      if (!pop) return;
      document.removeEventListener('mousedown', outside, true);
      root.removeChild(pop);
      pop = null;
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
      if (opts.onClose) opts.onClose();
    }

    function outside(e) { if (!root.contains(e.target)) close(false); }

    function choose(item) {
      close(false);
      if (item === 'new') { if (opts.onNew) opts.onNew(); } else opts.onPick(item.id);
    }

    function option(item, i, text) {
      var li = el('li', 'pick-opt' + (i === active ? ' on' : ''));
      li.id = id + '-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      if (text) { li.appendChild(el('span', 'pick-name', text)); li.className += ' pick-new'; return li; }
      var dot = el('i', 'ctx-dot');
      if (/^#[0-9a-fA-F]{3,8}$/.test(item.color)) dot.style.background = item.color;
      li.appendChild(dot);
      li.appendChild(el('span', 'pick-name', item.name));
      if (item.id === opts.suggestedId) li.appendChild(el('span', 'pick-tag', 'Suggested'));
      if (item.meta) li.appendChild(el('span', 'pick-meta', item.meta));
      return li;
    }

    function draw() {
      var q = input.value.trim().toLowerCase();
      shown = items.filter(function (it) { return !q || it.name.toLowerCase().indexOf(q) !== -1; });
      shown.push('new');
      if (active >= shown.length) active = shown.length - 1;
      while (list.firstChild) list.removeChild(list.firstChild);
      shown.forEach(function (it, i) {
        list.appendChild(option(it, i, it === 'new' ? (opts.newLabel || 'New context\u2026') : null));
      });
      input.setAttribute('aria-activedescendant', id + '-' + active);
      var on = list.children[active];
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      if (pop || btn.disabled) return;
      if (opts.onOpen) opts.onOpen();
      pop = el('div', 'pick-pop');
      input = el('input', 'pick-input');
      input.type = 'text';
      input.placeholder = 'Search contexts';
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-controls', id + '-list');
      input.setAttribute('aria-label', opts.ariaLabel || 'Assign to a context');
      list = el('ul', 'pick-list');
      list.id = id + '-list';
      list.setAttribute('role', 'listbox');
      pop.appendChild(input);
      pop.appendChild(list);
      root.appendChild(pop);
      btn.setAttribute('aria-expanded', 'true');
      active = 0;
      draw();
      // Open upward when the scroll area has no room below (phones: the bottom tab bar).
      var box = root.closest('.panel-body') || document.documentElement;
      if (pop.getBoundingClientRect().bottom > Math.min(box.getBoundingClientRect().bottom, window.innerHeight)) {
        pop.className += ' up';
      }
      input.focus();
      document.addEventListener('mousedown', outside, true);

      input.addEventListener('input', function () { active = 0; draw(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % shown.length; draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + shown.length) % shown.length; draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (e.key === 'Tab') close(false);
      });
      list.addEventListener('mousedown', function (e) { e.preventDefault(); });
      list.addEventListener('click', function (e) {
        var li = e.target.closest('.pick-opt');
        if (li) choose(shown[Array.prototype.indexOf.call(list.children, li)]);
      });
    }

    btn.addEventListener('click', function () { if (pop) close(true); else open(); });
    return root;
  }

  window.MCPicker = { create: create };
})();
