// ── Layout presets (Contexts tab) ─────────────────────────────────────────────
// The "Layouts" section (default select, Save layout, rename, delete) and the per-card "Layout" select.
// contexts.js passes its DOM helpers and its act(); this file only builds elements. All text goes in with
// textContent (through h), never innerHTML.

(function (root) {
  'use strict';

  function seg(id) { return encodeURIComponent(String(id)); }

  root.MCLayouts = function (deps) {
    var h = deps.h, add = deps.add, button = deps.button, act = deps.act, request = deps.request, busy = deps.busy;
    var logic = root.MCContextsLogic;

    var api = {
      capture: function () { return request('POST', '/api/contexts/layouts/capture', {}); },
      rename: function (id, name) { return request('PATCH', '/api/contexts/layouts/' + seg(id), { name: name }); },
      remove: function (id) { return request('DELETE', '/api/contexts/layouts/' + seg(id)); },
      setDefault: function (id) { return request('PATCH', '/api/contexts/settings', { defaultLayoutId: id }); },
      setForContext: function (contextId, id) { return request('PATCH', '/api/contexts/' + seg(contextId), { layoutId: id }); },
    };

    function select(key, label, options, value, disabled, onChange) {
      var box = h('select', 'ctx-select', null, { 'data-fk': key, 'aria-label': label });
      options.forEach(function (o) {
        var opt = h('option', null, o.label, { value: o.value });
        if (o.value === value) opt.selected = true;
        box.appendChild(opt);
      });
      if (disabled) box.disabled = true;
      box.addEventListener('change', function () { onChange(box.value); });
      return box;
    }

    function presetRow(p, d, control) {
      var row = h('li', 'ctx-layout-row');
      var meta = logic.layoutMeta(p) + (p.id === d.defaultLayoutId ? ' · default' : '');
      add(row, h('span', 'ctx-layout-name', p.name), h('span', 'ctx-muted', meta),
        button('Rename', 'link', 'layout-rename:' + p.id, function () {
          var name = root.prompt('Rename layout', p.name);
          if (name == null || !name.trim() || name.trim() === p.name) return;
          act('layout-rename:' + p.id, function () {
            return api.rename(p.id, name.trim()).then(function () { return { notice: 'Renamed to ' + name.trim() }; });
          });
        }, !!busy['layout-rename:' + p.id]),
        button('Delete', 'link', 'layout-delete:' + p.id, function () {
          if (!root.confirm('Delete "' + p.name + '"? Contexts using it go back to the default.')) return;
          act('layout-delete:' + p.id, function () {
            return api.remove(p.id).then(function () { return { notice: 'Deleted ' + p.name }; });
          });
        }, !!busy['layout-delete:' + p.id]));
      if (logic.layoutScreens(p) > 1) {
        row.appendChild(h('div', 'ctx-layout-hint ctx-muted',
          'Uses two screens. Needs “Displays have separate Spaces” off in Desktop & Dock settings.'));
      }
      return row;
    }

    // Below Auto-tidy: the default, Save layout, and the saved presets.
    function section(d, control) {
      var box = h('div', 'ctx-foot ctx-layouts');
      var head = h('div', 'ctx-toggle');
      add(head, h('span', 'ctx-toggle-name', 'Layouts'),
        select('layout-default', 'Default layout', logic.defaultLayoutOptions(d.layouts), d.defaultLayoutId || '', false, function (v) {
          act('layout-default', function () {
            return api.setDefault(v || null).then(function () { return { notice: v ? 'Tidy uses this layout by default' : 'Tidy lays out windows automatically' }; });
          });
        }),
        button(busy['layout-save'] ? 'Saving…' : 'Save layout', '', 'layout-save', function () {
          act('layout-save', function () {
            return api.capture().then(function (res) { return { notice: 'Saving the desktop on screen as ' + res.name }; });
          });
        }, !control || !!busy['layout-save'], 'Save where the windows on the desktop on screen are now'));
      box.appendChild(head);
      if (!d.layouts.length) {
        box.appendChild(h('div', 'ctx-muted', 'Arrange a desktop by hand, then save it. Tidy puts windows back there.'));
        return box;
      }
      var list = h('ul', 'ctx-layout-list');
      d.layouts.forEach(function (p) { list.appendChild(presetRow(p, d, control)); });
      box.appendChild(list);
      return box;
    }

    // On a card: Default / Auto / each preset.
    function cardSelect(c, d) {
      var key = 'layout:' + c.id;
      var line = h('label', 'ctx-card-layout ctx-muted');
      add(line, h('span', null, 'Layout'),
        select(key, 'Layout for ' + c.name, logic.layoutOptions(d.layouts, d.defaultLayoutId), c.layoutId || '', !!busy[key], function (v) {
          act(key, function () {
            return api.setForContext(c.id, v || null).then(function () { return { notice: 'Layout set for ' + c.name }; });
          });
        }));
      return line;
    }

    return { section: section, cardSelect: cardSelect };
  };
})(window);
