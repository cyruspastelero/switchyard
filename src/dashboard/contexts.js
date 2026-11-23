// ── Contexts tab ──────────────────────────────────────────────────────────────
// Rows per context (agents, windows, cost), "Needs you" strip, Unsorted windows,
// tab-move suggestions. Plain JS, no build step. All text from the API is set
// with textContent, never innerHTML.
//
// All API calls and response parsing live in the `api` object and `normalize`
// below, so shape changes only touch this top section.

(function () {
  'use strict';

  // ── API layer (the only place that knows URLs and response shapes) ───────

  function request(method, path, body) {
    var opts = { method: method, credentials: 'include' };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        if (res.status === 401) { window.location.href = '/login'; throw new Error('Signed out'); }
        if (!res.ok) {
          var msg = data && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status;
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function seg(id) { return encodeURIComponent(String(id)); }

  var api = {
    list: function () { return request('GET', '/api/contexts').then(normalize); },
    switchTo: function (id) { return request('POST', '/api/contexts/' + seg(id) + '/switch', {}); },
    park: function (id) { return request('POST', '/api/contexts/' + seg(id) + '/park', {}); },
    restore: function (id) { return request('POST', '/api/contexts/' + seg(id) + '/restore', {}); },
    sort: function () { return request('POST', '/api/contexts/sort', {}); },
    gather: function (id) { return request('POST', '/api/contexts/' + seg(id) + '/gather', {}); },
    assign: function (windowKey, contextId) {
      return request('POST', '/api/contexts/assign', { windowKey: windowKey, contextId: contextId });
    },
    unassign: function (windowKey) {
      return request('POST', '/api/contexts/unassign', { windowKey: windowKey });
    },
    focusWindow: function (windowKey) {
      return request('POST', '/api/contexts/windows/focus', { windowKey: windowKey });
    },
    nameWindow: function (windowKey, name) {
      return request('POST', '/api/contexts/windows/name', { windowKey: windowKey, name: name });
    },
    renameContext: function (id, name) { return request('PATCH', '/api/contexts/' + seg(id), { name: name }); },
    showAll: function () { return request('POST', '/api/contexts/show-all', {}); },
    tidy: function (contextId) { return request('POST', '/api/contexts/tidy', contextId ? { contextId: contextId } : {}); },
    undoTidy: function (desktop) { return request('POST', '/api/contexts/tidy/undo', { desktop: desktop }); },
    setAutoTidy: function (on) { return request('PATCH', '/api/contexts/settings', { autoTidy: on }); },
    // Resolves to the new context's id (accepts { id } or { context: { id } }).
    create: function (name) {
      return request('POST', '/api/contexts', { name: name }).then(function (res) {
        var id = res && (res.id || (res.context && res.context.id));
        if (!id) throw new Error('The server did not return the new context.');
        return id;
      });
    },
  };

  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v, fallback) { return typeof v === 'string' && v ? v : (fallback || ''); }

  // GET /api/contexts (and the `contexts` WebSocket message) -> view model.
  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var contexts = arr(raw.contexts).map(function (c) {
      return {
        id: String(c.id),
        name: str(c.name, 'Untitled'),
        key: c.key == null ? null : c.key,
        color: str(c.color),
        status: str(c.status, 'idle'),
        agents: arr(c.agents).map(function (a) {
          return {
            id: String(a.id),
            name: str(a.name, 'Agent'),
            status: str(a.status, 'idle'),
            lastAction: str(a.lastAction),
            costToday: typeof a.costToday === 'number' ? a.costToday : null,
          };
        }),
        windows: arr(c.windows).map(normWindow),
        parkedWindowCount: Number(c.parkedWindowCount) || 0,
        desktop: typeof c.desktop === 'number' ? c.desktop : null,
        desktopShared: c.desktopShared === true,
        layoutId: typeof c.layoutId === 'string' ? c.layoutId : null,
      };
    });
    var waiting = typeof raw.waitingCount === 'number'
      ? raw.waitingCount
      : contexts.filter(function (c) { return c.status === 'waiting'; }).length;
    var failure = raw.lastFailure && typeof raw.lastFailure === 'object'
      ? { action: str(raw.lastFailure.action), error: str(raw.lastFailure.error, 'no detail'), at: str(raw.lastFailure.at, '') } : null;
    return {
      windowControl: raw.windowControl === true,
      activeContextId: raw.activeContextId == null ? null : String(raw.activeContextId),
      lastFailure: failure,
      contexts: contexts,
      unsorted: arr(raw.unsorted).map(normWindow),
      suggestions: arr(raw.suggestions).map(function (s) {
        return {
          id: String(s.id),
          url: str(s.url),
          title: str(s.title),
          toContextId: String(s.toContextId),
          fromWindowKey: str(s.fromWindowKey),
        };
      }),
      waitingCount: waiting,
      desktopMode: raw.desktopMode === 'desktops' ? 'desktops' : 'offscreen',
      activeDesktop: raw.desktops && typeof raw.desktops.active === 'number' ? raw.desktops.active : null,
      desktopNote: str(raw.desktopNote),
      toSort: typeof raw.toSort === 'number' ? raw.toSort : 0,
      unsortedToMove: typeof raw.unsortedToMove === 'number' ? raw.unsortedToMove : 0,
      desktopCount: raw.desktops && typeof raw.desktops.count === 'number' ? raw.desktops.count : null,
      autoTidy: raw.autoTidy !== false,
      layouts: arr(raw.layouts).filter(function (p) { return p && typeof p.id === 'string' && Array.isArray(p.slots); }),
      defaultLayoutId: typeof raw.defaultLayoutId === 'string' ? raw.defaultLayoutId : null,
      desktopList: window.MCDesktops ? window.MCDesktops.normalize(raw.desktopList) : null,
    };
  }

  function normWindow(w) {
    return {
      key: String(w.key),
      app: str(w.app, 'App'),
      bundleId: str(w.bundleId),
      title: str(w.title),
      name: str(w.name),
      why: str(w.why),
      tabCount: typeof w.tabCount === 'number' ? w.tabCount : null,
      desktop: typeof w.desktop === 'number' ? w.desktop : null,
      hidden: w.hidden === true,
    };
  }

  // ── State ────────────────────────────────────────────────────────────────

  var STATUS_LABEL = { working: 'Working', waiting: 'Waiting on you', idle: 'Idle', parked: 'Parked' };
  var NO_CONTROL_NOTE = "The Switchyard Mac app isn't connected, so windows can't be moved.";
  var ONE_DESKTOP_NOTE = 'Switchyard sees windows on every desktop. One opened on another desktop while Switchyard was closed shows up once you go there.';
  var logic = window.MCContextsLogic;

  var st = {
    data: null,
    loaded: false,
    error: '',         // the last load failed
    actionError: '',   // the server's reason the last action failed; kept until the next action
    notice: '',        // what the last action did, shown for a few seconds
    busy: {},          // action key -> true while a request is in flight
    renaming: null,    // window key being renamed
    newTopicFor: null, // window key waiting for a new topic name
    dirty: false,      // data arrived while editing; render when editing ends
    showSystem: false, // show windows from system/utility apps in Unsorted
    picking: null,     // window key whose assign picker is open
    noIcon: {},        // bundle ids the server has no icon for: show the letter instead
  };

  var $view = document.getElementById('contexts-view');
  var $body = document.getElementById('contexts-body');
  var $sortBtn = document.getElementById('contexts-sort');
  var $showAllBtn = document.getElementById('contexts-show-all');
  var $badge = document.getElementById('contexts-badge');
  var $headTab = document.getElementById('view-tab-contexts');
  var $headOverview = document.getElementById('view-tab-overview');
  var $mobCount = document.getElementById('mob-contexts-count');
  if (!$view || !$body || !logic) return;

  // ── DOM helpers ──────────────────────────────────────────────────────────

  function h(tag, cls, text, attrs) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }

  function button(label, cls, key, onClick, disabled, title) {
    var b = h('button', 'ctx-btn ' + (cls || ''), label, { type: 'button', 'data-fk': key });
    if (disabled) b.disabled = true;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function dot(color) {
    var d = h('i', 'ctx-dot');
    if (/^#[0-9a-fA-F]{3,8}$/.test(color)) d.style.background = color;
    return d;
  }

  function pill(status) {
    var p = h('span', 'ctx-pill ctx-pill-' + (STATUS_LABEL[status] ? status : 'idle'));
    add(p, h('i', 'ctx-pill-dot'), h('span', null, STATUS_LABEL[status] || status));
    return p;
  }

  function money(n) {
    if (n >= 1) return '$' + n.toFixed(2);
    return '$' + n.toFixed(n >= 0.01 ? 3 : 4);
  }

  // Windows from these apps are never project work: Unsorted hides them behind a toggle.
  var SYSTEM_BUNDLE_PREFIXES = ['com.apple.systempreferences', 'com.apple.finder', 'ph.pastelero.switchyard'];

  function isSystemWindow(w) {
    return SYSTEM_BUNDLE_PREFIXES.some(function (p) { return w.bundleId.indexOf(p) === 0; });
  }

  function isEditing() { return st.renaming !== null || st.newTopicFor !== null || st.picking !== null; }

  // ── Loading and actions ──────────────────────────────────────────────────

  function setData(data) {
    // The app just connected, so a "not reporting" reason from an earlier action is out of date.
    if (data.windowControl && !(st.data && st.data.windowControl)) st.actionError = '';
    st.data = data;
    st.loaded = true;
    st.error = '';
    updateBadges();
    if (isEditing()) { st.dirty = true; return; }
    render();
  }

  function load() {
    return api.list().then(setData).catch(function (err) {
      st.loaded = true;
      st.error = "Couldn't load contexts: " + err.message;
      if (!isEditing()) render();
    });
  }

  var noticeTimer = null;

  // Runs one action, then refetches whatever the outcome. `name` is the context the action is about, if any.
  // The result is always said out loud: a notice when it worked, the server's reason when it did not.
  function act(key, fn, name) {
    if (st.busy[key]) return Promise.resolve();
    st.busy[key] = true;
    st.actionError = '';
    st.notice = '';
    clearTimeout(noticeTimer);
    render();
    st.followUp = null;
    return fn().then(function (res) {
      // An action may answer with its own words and one follow-up button (Go, Undo).
      st.notice = (res && res.notice) || logic.doneText(key.split(':')[0], name);
      st.followUp = (res && res.followUp) || null;
      noticeTimer = setTimeout(function () { st.notice = ''; st.followUp = null; if (!isEditing()) render(); }, st.followUp ? 10000 : 4000);
    }).catch(function (err) {
      st.actionError = err.message || 'That did not work.';
    }).then(function () {
      delete st.busy[key];
      st.renaming = null;
      st.newTopicFor = null;
      st.dirty = false;
      return load();
    });
  }

  function updateBadges() {
    var b = logic.countBadge(st.data ? st.data.waitingCount : 0);
    [$badge, $mobCount].forEach(function (el) { if (el) { el.textContent = b.text; el.hidden = b.hidden; } });
  }

  function endEdit() {
    st.renaming = null;
    st.newTopicFor = null;
    st.dirty = false;
    render();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function render() {
    if (!$view.classList.contains('active') && st.loaded && $body.firstChild) {
      // Hidden view: skip the work, show() renders when it opens.
      st.dirty = true;
      return;
    }
    var focusKey = document.activeElement && $body.contains(document.activeElement)
      ? document.activeElement.getAttribute('data-fk') : null;

    var frag = document.createDocumentFragment();
    var d = st.data;
    var control = !!(d && d.windowControl);

    if ($sortBtn) {
      $sortBtn.disabled = !control || !!st.busy.sort;
      $sortBtn.title = control ? '' : NO_CONTROL_NOTE;
      var label = d ? logic.sortLabel(d.toSort, d.unsortedToMove, d.desktopCount) : 'Sort windows';
      $sortBtn.textContent = st.busy.sort ? logic.busyLabel('sort') : label;
      if (control && label !== 'Sort windows') $sortBtn.title = label.replace(/^Sort \u00B7 /, '') + '. Keep hands off the mouse while it runs; Esc stops it.';
    }
    var $newCtx = document.getElementById('contexts-new');
    if ($newCtx) $newCtx.disabled = !d;
    if ($showAllBtn) {
      $showAllBtn.disabled = !control || !!st.busy.showAll;
      $showAllBtn.title = control ? 'Bring back every window Switchyard has hidden' : NO_CONTROL_NOTE;
      $showAllBtn.textContent = st.busy.showAll ? logic.busyLabel('showAll') : 'Show all windows';
    }

    var errorText = st.error || st.actionError;
    if (errorText) frag.appendChild(h('div', 'ctx-error', errorText, { role: 'alert' }));
    else if (st.notice && !(d && d.lastFailure)) frag.appendChild(noticeLine());
    if (d && d.lastFailure) frag.appendChild(h('div', 'ctx-error', logic.failureText(d.lastFailure, Date.now()), { role: 'alert' }));

    if (!st.loaded) {
      frag.appendChild(h('div', 'ctx-note', 'Loading contexts\u2026'));
    } else if (d) {
      if (logic.needsSetup(d)) frag.appendChild(setupCard(d));
      if (d.contexts.length || d.unsorted.length) {
        frag.appendChild(summary(d));
        var needs = needsYou(d, control);
        if (needs) frag.appendChild(needs);
        if (d.suggestions.length && suggestionsUi) frag.appendChild(suggestionsUi.section(d, control, control ? '' : NO_CONTROL_NOTE));
        frag.appendChild(cards(d, control));
        if (d.unsorted.length || dragUi) frag.appendChild(unsortedSection(d)); // empty: shown only as a drop target
        if (control && d.desktopNote) frag.appendChild(h('div', 'ctx-foot ctx-muted', d.desktopNote));
        else if (control && d.desktopMode !== 'desktops') frag.appendChild(h('div', 'ctx-foot ctx-muted', ONE_DESKTOP_NOTE));
        if (d.desktopMode === 'desktops') frag.appendChild(autoTidyToggle(d));
        if (d.desktopMode === 'desktops') add(frag, desktopsUi && desktopsUi.section(d, control), layoutsUi && layoutsUi.section(d, control));
      }
    } else {
      var note = logic.noDataNote(errorText);
      if (note) frag.appendChild(h('div', 'ctx-note', note));
      frag.appendChild(button('Try again', '', 'retry', load));
    }

    while ($body.firstChild) $body.removeChild($body.firstChild);
    $body.appendChild(frag);

    var input = $body.querySelector('.ctx-input');
    if (input) { input.focus(); input.select(); }
    else if (focusKey) {
      var again = $body.querySelector('[data-fk="' + focusKey.replace(/["\\]/g, '\\$&') + '"]');
      if (again && !again.disabled) again.focus();
    }
  }

  // editing(on) holds re-renders while a window is dragged, the way an open picker does.
  var uiDeps = { h: h, add: add, button: button, act: act, request: request, busy: st.busy, appIcon: appIcon, isSystemWindow: isSystemWindow, data: function () { return st.data; },
    editing: function (on) { st.picking = on ? 'drag' : null; if (!on && st.dirty) endEdit(); } };
  var dragUi = uiDeps.drag = window.MCDragDrop ? window.MCDragDrop(uiDeps) : null;
  var newContextUi = window.MCNewContext ? window.MCNewContext(uiDeps) : null;
  var layoutsUi = window.MCLayouts ? window.MCLayouts(uiDeps) : null;
  var desktopsUi = window.MCDesktops ? window.MCDesktops(uiDeps) : null;
  var suggestionsUi = window.MCSuggestions ? window.MCSuggestions(uiDeps) : null;

  function noticeLine() {
    var f = st.followUp;
    var line = h('div', 'ctx-ok' + (f && f.toast ? ' ctx-toast' : ''), st.notice, { role: 'status' });
    if (f) line.appendChild(button(f.label, 'link', 'followup', function () { act(f.key, f.run, f.name); }));
    return line;
  }

  function autoTidyToggle(d) {
    var label = h('label', 'ctx-foot ctx-muted ctx-toggle');
    var box = h('input', 'ctx-switch', null, { type: 'checkbox', role: 'switch', 'data-fk': 'auto-tidy' });
    box.checked = d.autoTidy;
    box.addEventListener('change', function () {
      act('autoTidy', function () { return api.setAutoTidy(box.checked).then(function () { return { notice: box.checked ? 'Sort and Move tidy the desktops they change' : 'Only Tidy lays out windows now' }; }); });
    });
    return add(label, box, h('span', 'ctx-toggle-name', 'Auto-tidy'),
      h('span', 'ctx-toggle-hint', 'Lay out each desktop after Sort and Move'));
  }

  // First run, and any time a step is still open: what Switchyard does and what to do next.
  function setupCard(d) {
    var first = !d.contexts.length;
    var card = h('section', 'ctx-setup', null, { 'aria-label': 'Getting started' });
    add(card,
      h('div', 'ctx-setup-title', first ? 'Switchyard sorts your windows by project' : 'One more step'),
      h('div', 'ctx-setup-lead', first
        ? 'Each project you run an agent in becomes a context with its own desktop. Switch to one and its windows come forward; the rest step aside.'
        : 'Agents are reporting. Window switching starts once the Mac app is connected.'));
    var list = h('ol', 'ctx-steps');
    logic.setupSteps(d).forEach(function (s, i) {
      var li = h('li', 'ctx-step' + (s.done ? ' done' : ''));
      var body = h('div', 'ctx-step-body');
      add(body, h('div', 'ctx-step-title', s.title), h('div', 'ctx-step-text', s.text));
      add(li, h('span', 'ctx-step-mark', s.done ? '\u2713' : String(i + 1), { 'aria-hidden': 'true' }), body,
        h('span', 'ctx-step-state', s.done ? 'Done' : 'To do'));
      list.appendChild(li);
    });
    add(card, list, h('div', 'ctx-setup-foot', ONE_DESKTOP_NOTE));
    return card;
  }

  function stat(value, label) {
    var s = h('span', 'ctx-stat');
    add(s, h('b', null, value), document.createTextNode(label));
    return s;
  }

  function summary(d) {
    var live = d.contexts.filter(function (c) { return c.status !== 'parked'; });
    var agentCount = live.reduce(function (n, c) { return n + c.agents.length; }, 0);
    var cost = 0, hasCost = false;
    d.contexts.forEach(function (c) {
      c.agents.forEach(function (a) { if (a.costToday != null) { cost += a.costToday; hasCost = true; } });
    });
    var el = h('div', 'ctx-summary');
    add(el,
      stat(String(d.contexts.length), d.contexts.length === 1 ? ' context' : ' contexts'),
      stat(String(agentCount), agentCount === 1 ? ' agent' : ' agents'),
      stat(String(d.waitingCount), ' waiting on you'),
      stat(hasCost ? money(cost) : '\u2014', ' today'));
    return el;
  }

  function needsYou(d, control) {
    var waiting = d.contexts.filter(function (c) { return c.status === 'waiting'; });
    if (!waiting.length) return null;
    var box = h('section', 'ctx-needs', null, { 'aria-label': 'Needs you' });
    add(box, h('div', 'ctx-section-title', 'Needs you'));
    waiting.forEach(function (c) {
      var agent = c.agents.filter(function (a) { return a.status === 'waiting'; })[0];
      var line = h('div', 'ctx-needs-row');
      var text = h('span', 'ctx-needs-text');
      add(text, h('b', null, c.name));
      if (agent && agent.lastAction) text.appendChild(document.createTextNode(' \u00B7 ' + agent.lastAction));
      add(line, pill('waiting'), text,
        button('Jump', 'primary', 'jump:' + c.id, function () {
          act('switch:' + c.id, function () { return api.switchTo(c.id); }, c.name);
        }, !control || !!st.busy['switch:' + c.id], control ? '' : NO_CONTROL_NOTE));
      box.appendChild(line);
    });
    return box;
  }

  // One compact card per context, in desktop order (Desktop 1…N, as in Mission Control).
  function cards(d, control) {
    var grid = h('div', 'ctx-cards', null, { role: 'list', 'aria-label': 'Contexts' });
    logic.byDesktop(d.contexts).forEach(function (c) { grid.appendChild(contextCard(c, d, control)); });
    return grid;
  }

  function contextCard(c, d, control) {
    var parked = c.status === 'parked';
    var active = d.activeContextId === c.id;
    var card = h('article', 'ctx-card' + (parked ? ' parked' : '') + (active ? ' active' : ''), null, { role: 'listitem' });
    if (dragUi) dragUi.card(card, c);

    // Same order on every card: head (dot, name, actions), meta, one agent line (maybe empty), windows.
    var head = h('div', 'ctx-card-head');
    add(head, dot(c.color), st.renaming === 'ctx:' + c.id ? contextNameForm(c) : contextName(c), cardActions(c, control, parked));
    var meta = desktopsUi ? desktopsUi.cardMeta(c, d) : h('div', 'ctx-card-meta ctx-status-' + c.status, logic.cardMeta(c) + (c.desktopShared ? ' \u00B7 shared' : ''));
    var actions = c.agents.map(function (a) { return a.name + (a.lastAction ? ': ' + a.lastAction : ''); }).join('\n');
    var agents = h('div', 'ctx-card-agents', logic.agentSummary(c), actions ? { title: actions } : null);
    add(card, head, meta, agents, !parked && c.desktop != null && layoutsUi && d.layouts.length ? layoutsUi.cardSelect(c, d) : null);

    var wins = h('ul', 'ctx-card-wins');
    if (parked) {
      wins.appendChild(noteRow(c.parkedWindowCount
        ? c.parkedWindowCount + (c.parkedWindowCount === 1 ? ' window' : ' windows') + ' closed \u00B7 tabs saved'
        : 'Windows closed \u00B7 tabs saved'));
    } else if (c.windows.length) {
      var moveTo = logic.moveItems(d.contexts, c.id);
      var home = c.desktop != null ? c.desktop : d.activeDesktop;
      c.windows.forEach(function (w) { wins.appendChild(windowLine(w, moveTo, home, c)); });
      var stray = logic.strayHint(c);
      if (stray) wins.appendChild(add(noteRow(stray), button('Move here', 'link', 'gather:' + c.id, function () {
        act('gather:' + c.id, function () { return api.gather(c.id); }, c.name);
      }, !control || !!st.busy['gather:' + c.id])));
    } else {
      wins.appendChild(noteRow('No windows yet'));
    }
    card.appendChild(wins);
    return card;
  }

  function cardActions(c, control, parked) {
    var acts = h('div', 'ctx-acts');
    var tip = control ? '' : NO_CONTROL_NOTE;
    if (parked) {
      acts.appendChild(button(st.busy['restore:' + c.id] ? logic.busyLabel('restore') : 'Restore', 'primary', 'restore:' + c.id, function () {
        act('restore:' + c.id, function () { return api.restore(c.id); }, c.name);
      }, !control || !!st.busy['restore:' + c.id], tip));
      return acts;
    }
    return add(acts,
      button(st.busy['park:' + c.id] ? logic.busyLabel('park') : 'Park', '', 'park:' + c.id, function () {
        act('park:' + c.id, function () { return api.park(c.id); }, c.name);
      }, !control || !!st.busy['park:' + c.id], tip || 'Close this context\u2019s browser windows and save their tabs'),
      c.desktop != null ? button(st.busy['tidy:' + c.id] ? logic.busyLabel('tidy') : 'Tidy', '', 'tidy:' + c.id, function () {
        act('tidy:' + c.id, function () { return api.tidy(c.id).then(tidyResult); });
      }, !control || !!st.busy['tidy:' + c.id], tip || 'Lay out every window on Desktop ' + c.desktop) : null,
      button(st.busy['switch:' + c.id] ? logic.busyLabel('switch') : 'Switch', 'primary', 'switch:' + c.id, function () {
        act('switch:' + c.id, function () { return api.switchTo(c.id); }, c.name);
      }, !control || !!st.busy['switch:' + c.id], tip || 'Show this context\u2019s windows and hide the others'));
  }

  function tidyResult(res) {
    var undo = res.windows > 0
      ? { label: 'Undo tidy', key: 'undoTidy', run: function () { return api.undoTidy(res.desktop); } } : null;
    return { notice: logic.tidyText(res), followUp: undo };
  }

  // "Moved to aral · Desktop 2 · Go": the owner stays put; Go follows the window.
  function moveResult(res, target) {
    var go = res && res.moving && target && target.id !== logic.UNSORTED_ID
      ? { label: 'Go', key: 'switch:' + target.id, name: target.name, run: function () { return api.switchTo(target.id); } } : null;
    return { notice: logic.moveResultText(res, target ? target.name : 'Unsorted'), followUp: go };
  }

  function letterIcon(w) {
    return h('span', 'ctx-app-icon', (w.app.trim()[0] || '?').toUpperCase(), { role: 'img', title: w.app, 'aria-label': w.app });
  }

  // The app's real icon (uploaded by the Mac app); its first letter when the server has none.
  function appIcon(w) {
    if (!w.bundleId || st.noIcon[w.bundleId]) return letterIcon(w);
    var img = h('img', 'ctx-app-img', null, {
      src: '/api/contexts/icons/' + encodeURIComponent(w.bundleId), alt: w.app, title: w.app, width: '16', height: '16',
    });
    img.addEventListener('error', function () {
      st.noIcon[w.bundleId] = true;
      if (img.parentNode) img.parentNode.replaceChild(letterIcon(w), img);
    });
    return img;
  }

  // The title is a button: it brings this one window to the front.
  function windowTitle(w, activeDesktop, unsorted) {
    var key = 'focus:' + w.key;
    var b = h('button', 'ctx-w-text', null, { type: 'button', 'data-fk': key, title: logic.windowTip(w) });
    var parts = logic.windowParts(w);
    b.appendChild(h('span', 'ctx-w-label', parts.text));
    if (parts.tabs) b.appendChild(h('span', 'ctx-w-tabs', '\u00B7 ' + parts.tabs));
    var place = logic.windowPlace(w, activeDesktop, unsorted);
    if (place) b.appendChild(h('span', 'ctx-w-place', place));
    b.addEventListener('click', function () { act(key, function () { return api.focusWindow(w.key); }); });
    return b;
  }

  function noteRow(text) {
    var li = h('li', 'ctx-w ctx-w-note');
    li.appendChild(h('span', 'ctx-w-text', text));
    return li;
  }

  function windowLine(w, moveTo, activeDesktop, c) {
    if (st.renaming === w.key) return add(h('li', 'ctx-w'), renameForm(w));
    if (st.newTopicFor === w.key) return add(h('li', 'ctx-w'), newTopicForm(w));
    var li = h('li', 'ctx-w');
    if (dragUi) dragUi.source(li, w, { id: c.id, name: c.name }, logic.windowLabel(w));
    var acts = h('span', 'ctx-w-acts');
    if (logic.canRename(w)) {
      acts.appendChild(button('Rename', 'link ctx-w-rename', 'rename:' + w.key, function () {
        st.renaming = w.key;
        render();
      }, false, 'Rename this Chrome window'));
    }
    acts.appendChild(movePicker(w, logic.windowLabel(w), moveTo));
    return add(li, appIcon(w), windowTitle(w, activeDesktop), acts);
  }

  // Move a sorted window to another context, or back to Unsorted. Either way it is the owner's choice.
  function movePicker(w, text, moveTo) {
    var key = 'move:' + w.key;
    var picker = window.MCPicker.create({
      ariaLabel: 'Move ' + text + ' to another context',
      fk: key,
      disabled: !!st.busy[key],
      label: st.busy[key] ? logic.busyLabel('move') : 'Move',
      items: moveTo,
      onOpen: function () { st.picking = w.key; },
      onClose: function () { st.picking = null; if (st.dirty) endEdit(); },
      onPick: function (id) {
        var target = moveTo.filter(function (it) { return it.id === id; })[0];
        act(key, function () {
          return (id === logic.UNSORTED_ID ? api.unassign(w.key) : api.assign(w.key, id))
            .then(function (res) { return moveResult(res, target); });
        }, target ? target.name : '');
      },
      onNew: function () { st.newTopicFor = w.key; render(); },
    });
    picker.className += ' ctx-w-move';
    return picker;
  }

  // The context name is a button: click it to rename the context in place.
  function contextName(c) {
    var b = h('button', 'ctx-name-text', c.name, { type: 'button', title: 'Rename ' + c.name, 'aria-label': 'Rename ' + c.name });
    b.addEventListener('click', function () { st.renaming = 'ctx:' + c.id; render(); });
    return b;
  }

  function contextNameForm(c) {
    var form = h('form', 'ctx-inline-form ctx-name-form');
    var input = h('input', 'ctx-input', null, { type: 'text', maxlength: '60', 'aria-label': 'Context name' });
    input.value = c.name;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name || name === c.name) return endEdit();
      act('renameContext:' + c.id, function () { return api.renameContext(c.id, name); }, name);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
    });
    input.addEventListener('blur', function () { if (st.renaming === 'ctx:' + c.id) form.requestSubmit(); });
    form.appendChild(input);
    setTimeout(function () { input.focus(); input.select(); }, 0);
    return form;
  }

  function renameForm(w) {
    var form = h('form', 'ctx-inline-form');
    var input = h('input', 'ctx-input', null, {
      type: 'text', value: w.name || '', maxlength: '60', 'aria-label': 'Chrome window name',
    });
    input.value = w.name || logic.shortTitle(w.title);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name) return;
      act('name:' + w.key, function () { return api.nameWindow(w.key, name); });
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
    });
    add(form, input,
      button('Save', 'primary', 'save-name', function () { form.requestSubmit(); }),
      button('Cancel', '', 'cancel-name', endEdit));
    return form;
  }

  // Unsorted: one tidy list, each window with the same assign picker.
  function unsortedSection(d) {
    var box = h('section', 'ctx-unsorted-box' + (d.unsorted.length ? '' : ' ctx-unsorted-empty'), null, { 'aria-label': 'Unsorted windows' });
    if (dragUi) dragUi.unsorted(box);
    var system = d.unsorted.filter(isSystemWindow);
    var shown = st.showSystem ? d.unsorted.slice() : d.unsorted.filter(function (w) { return !isSystemWindow(w); });
    var head = h('div', 'ctx-unsorted-head');
    var count = logic.unsortedCountText(d.unsorted.length - system.length);
    add(head, h('span', 'ctx-section-title', 'Unsorted'), count ? h('span', 'ctx-muted', count) : null);
    box.appendChild(head);

    var list = h('ul', 'ctx-unsorted-list');
    var items = logic.byDesktop(d.contexts).map(function (c) {
      return { id: c.id, name: c.name, color: c.color, meta: logic.desktopLabel(c).replace(' \u00B7 shared', '') };
    });
    shown.forEach(function (w) { list.appendChild(unsortedWindow(w, d, items)); });
    if (!shown.length) list.appendChild(noteRow('Nothing to sort.'));
    box.appendChild(list);
    if (system.length) {
      box.appendChild(button(st.showSystem
        ? 'Hide system windows'
        : 'Show ' + system.length + ' system ' + (system.length === 1 ? 'window' : 'windows'),
      'link ctx-system-toggle', 'system-toggle', function () {
        st.showSystem = !st.showSystem;
        render();
      }));
    }
    return box;
  }

  function unsortedWindow(w, d, items) {
    var li = h('li', 'ctx-w');
    var text = logic.windowLabel(w);
    if (st.newTopicFor === w.key) return add(li, newTopicForm(w));
    if (dragUi) dragUi.source(li, w, null, text);
    add(li, appIcon(w), windowTitle(w, d.activeDesktop, true));
    var acts = add(h('span', 'ctx-w-acts ctx-w-acts-always'), window.MCPicker.create({
      ariaLabel: 'Assign ' + text + ' to a context',
      fk: 'assign:' + w.key,
      disabled: !!st.busy['assign:' + w.key],
      label: st.busy['assign:' + w.key] ? logic.busyLabel('assign') : 'Assign to\u2026',
      items: items,
      suggestedId: logic.suggestedContextId(w, d.contexts, d.suggestions),
      onOpen: function () { st.picking = w.key; },
      onClose: function () { st.picking = null; if (st.dirty) endEdit(); },
      onPick: function (id) {
        var target = items.filter(function (it) { return it.id === id; })[0];
        act('assign:' + w.key, function () { return api.assign(w.key, id).then(function (res) { return moveResult(res, target); }); });
      },
      onNew: function () { st.newTopicFor = w.key; render(); },
    }));
    return add(li, acts);
  }

  function newTopicForm(w) {
    var form = h('form', 'ctx-inline-form');
    var input = h('input', 'ctx-input', null, {
      type: 'text', maxlength: '40', placeholder: 'Context name', 'aria-label': 'New context name',
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name) return;
      act('assign:' + w.key, function () {
        return api.create(name).then(function (id) { return api.assign(w.key, id); });
      });
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
    });
    add(form, input,
      button('Create', 'primary', 'create-topic', function () { form.requestSubmit(); }),
      button('Cancel', '', 'cancel-topic', endEdit));
    return form;
  }

  // ── Sort button ──────────────────────────────────────────────────────────

  if ($sortBtn) {
    $sortBtn.addEventListener('click', function () {
      act('sort', function () { return api.sort(); });
    });
  }
  var $newBtn = document.getElementById('contexts-new');
  if ($newBtn && newContextUi) $newBtn.addEventListener('click', newContextUi.open);
  if ($showAllBtn) {
    $showAllBtn.addEventListener('click', function () {
      act('showAll', function () { return api.showAll(); });
    });
  }

  // ── View switching (desktop header tabs and mobile bottom tab) ───────────

  var pollTimer = null;

  var VIEW_KEY = 'switchyard_view';

  function savedView() {
    try { return localStorage.getItem(VIEW_KEY) === 'activity' ? 'overview' : 'contexts'; } catch (e) { return 'contexts'; }
  }

  function setView(name) {
    var on = name === 'contexts';
    try { localStorage.setItem(VIEW_KEY, on ? 'contexts' : 'activity'); } catch (e) {}
    if (on === $view.classList.contains('active')) return;
    document.body.classList.toggle('view-contexts', on);
    $view.classList.toggle('active', on);
    if ($headTab) { $headTab.classList.toggle('active', on); $headTab.setAttribute('aria-pressed', String(on)); }
    if ($headOverview) { $headOverview.classList.toggle('active', !on); $headOverview.setAttribute('aria-pressed', String(!on)); }
    if (typeof window.MCSetMobileTabName === 'function') window.MCSetMobileTabName(on ? 'contexts' : 'agents');
    clearInterval(pollTimer);
    pollTimer = null;
    if (on) {
      load();
      // Fallback for missed WebSocket messages.
      pollTimer = setInterval(function () { if (!document.hidden && !isEditing()) load(); }, 30000);
    }
  }

  if ($headTab) $headTab.addEventListener('click', function () { setView('contexts'); });
  if ($headOverview) $headOverview.addEventListener('click', function () { setView('overview'); });

  // Public hooks used by app.js.
  window.MCContexts = {
    setView: setView,
    // `contexts` WebSocket message: use its payload if it has the right shape, else refetch.
    onMessage: function (msg) {
      if (msg && msg.data && Array.isArray(msg.data.contexts)) setData(normalize(msg.data));
      else load();
    },
  };

  // Contexts is home. Restore the last chosen view (default: contexts).
  var first = savedView();
  if (first === 'contexts') {
    // Markup starts in the Contexts view; just start polling and load.
    pollTimer = setInterval(function () { if (!document.hidden && !isEditing()) load(); }, 30000);
    load();
  } else {
    setView('overview');
    load();
  }
})();
