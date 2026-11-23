// Pure helpers for the Contexts tab: first-run steps and the words shown after an action.
// No DOM here, so it is unit-tested (test/dashboard/contexts-logic.test.ts).

(function (root) {
  'use strict';

  // The three things that must be true before switching works, in the order to do them.
  function setupSteps(d) {
    var hasContexts = !!(d && d.contexts && d.contexts.length);
    var control = !!(d && d.windowControl);
    return [
      {
        id: 'agents',
        title: 'Start an agent',
        text: 'Start Claude Code in a project folder and it appears here as a context. '
          + 'If nothing shows up, run "switchyard install" once to add the hooks.',
        done: hasContexts,
      },
      {
        id: 'app',
        title: 'Open the Mac app',
        text: 'Switchyard.app lives in the menu bar and moves the windows. '
          + 'Allow it under System Settings › Privacy & Security › Accessibility.',
        done: control,
      },
      {
        id: 'switch',
        title: 'Switch',
        text: 'Press ⌥Space to search contexts or ⌥1–9 to jump to one. The Switch button here does the same.',
        done: hasContexts && control,
      },
    ];
  }

  function needsSetup(d) {
    return setupSteps(d).some(function (s) { return !s.done; });
  }

  var FAILED = {
    show: 'switch windows',
    showAll: 'bring the windows back',
    nameWindow: 'rename a browser window',
    openWindow: 'reopen a browser window',
    closeWindow: 'close a window',
    openTab: 'open a tab',
    closeTab: 'close a tab',
    moveWindows: 'move every window to its desktop',
    tidy: 'tidy the desktop',
    undoTidy: 'undo the tidy',
    captureLayout: 'save the layout',
  };

  function failureText(f) {
    if (!f) return '';
    return 'The Mac app could not ' + (FAILED[f.action] || 'finish the last action') + ': ' + f.error;
  }

  var BUSY = {
    switch: 'Switching…', park: 'Parking…', restore: 'Restoring…', sort: 'Sorting…',
    showAll: 'Showing…', accept: 'Moving…', name: 'Saving…', assign: 'Assigning…', move: 'Moving…',
    tidy: 'Tidying…', undoTidy: 'Undoing…',
  };

  function busyLabel(action) { return BUSY[action] || 'Working…'; }

  function doneText(action, name) {
    switch (action) {
      case 'switch': return 'Switched to ' + name;
      case 'park': return 'Parked ' + name + '. Its tabs are saved.';
      case 'restore': return 'Restored ' + name;
      case 'sort': return 'Windows sorted';
      case 'gather': return 'Moving ' + name + '\u2019s windows here';
      case 'showAll': return 'All windows are back';
      case 'accept': return 'Tab moved';
      case 'name': return 'Window renamed';
      case 'renameContext': return 'Renamed to ' + name;
      case 'assign': return 'Window assigned';
      case 'move': return 'Moved to ' + name;
      case 'undoTidy': return 'Tidy undone';
      default: return '';
    }
  }

  // Shown when there is no data: the error already says what went wrong, so only guess when there is none.
  function noDataNote(error) {
    return error ? '' : 'The server did not answer. It may be restarting.';
  }

  // The Mac app can name Chrome windows only.
  function canRename(w) {
    return !!w && w.bundleId === 'com.google.Chrome';
  }

  var UNSORTED_ID = '__unsorted__';

  // Picker items for moving a window out of `currentId`: every other context, then Unsorted.
  function moveItems(contexts, currentId) {
    return byDesktop(contexts).filter(function (c) { return c.id !== currentId; }).map(function (c) {
      return { id: c.id, name: c.name, color: c.color, meta: desktopLabel(c).replace(' \u00B7 shared', '') };
    }).concat([{ id: UNSORTED_ID, name: 'Unsorted', color: '', meta: 'Switchyard leaves it alone' }]);
  }

  // The row's second line. With real desktops: "Desktop 6 · shared · ⌥9"; in off-screen mode the old wording.
  function desktopLabel(c) {
    var key = c && c.key != null ? c.key : null;
    if (c && typeof c.desktop === 'number') {
      return 'Desktop ' + c.desktop + (c.desktopShared ? ' \u00B7 shared' : '') + (key != null ? ' \u00B7 \u2325' + key : '');
    }
    return key != null ? 'desktop ' + key + ' \u00B7 \u2325' + key : 'no desktop number';
  }

  function toSortText(n) {
    if (!n || n < 1) return '';
    return n === 1 ? '1 window to sort' : n + ' windows to sort';
  }

  // What the Sort button will do: "Sort · 2 to move · 1 unsorted to Desktop 6".
  function sortLabel(toSort, unsortedToMove, shared) {
    var parts = [];
    if (toSort > 0) parts.push(toSort + ' to move');
    if (unsortedToMove > 0) parts.push(unsortedToMove + ' unsorted' + (shared ? ' to Desktop ' + shared : ''));
    return parts.length ? ['Sort'].concat(parts).join(' \u00B7 ') : 'Sort windows';
  }

  // A context's windows that sit on another desktop: "2 windows are on Desktop 1" plus a Move here button. '' when there are none.
  function strayHint(c) {
    if (!c || typeof c.desktop !== 'number') return '';
    var away = (c.windows || []).filter(function (w) { return typeof w.desktop === 'number' && w.desktop !== c.desktop; });
    if (!away.length) return '';
    var where = away.every(function (w) { return w.desktop === away[0].desktop; }) ? 'Desktop ' + away[0].desktop : 'other desktops';
    return away.length === 1 ? '1 window is on ' + where + '.' : away.length + ' windows are on ' + where + '.';
  }

  // After a Move: the server says whether it is carrying the window and to which desktop.
  function moveResultText(result, name) {
    var text = 'Moved to ' + name;
    return result && result.moving && typeof result.desktop === 'number' ? text + ' \u00B7 Desktop ' + result.desktop : text;
  }

  function tidyText(result) {
    return result.windows > 0 ? 'Tidied Desktop ' + result.desktop : 'Nothing to tidy on Desktop ' + result.desktop;
  }

  // Browsers append " - Google Chrome - <profile name>"; the profile is often the owner's name. Drop both.
  var BROWSER_SUFFIX = /\s+[-–—]\s+(Google Chrome|Chromium|Microsoft Edge|Brave|Arc|Mozilla Firefox|Firefox|Safari|Opera|Vivaldi)(\s+[-–—]\s+.*)?$/;

  function shortTitle(title) {
    var t = String(title || '').trim();
    if (!t) return 'Untitled';
    var short = t.replace(BROWSER_SUFFIX, '').replace(/^[-\u2013\u2014\u00B7|\s]+/, '').trim();
    return short || t;
  }

  function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }

  // "name · real title · 3 tabs": a custom name never hides what the window shows now.
  function windowLabel(w) {
    var p = windowParts(w);
    return p.tabs ? p.text + ' \u00B7 ' + p.tabs : p.text;
  }

  // The row shows the tab count apart from the title, so truncating a long title never hides it.
  function windowParts(w) {
    var title = shortTitle(w.title);
    var text = w.name && w.name !== title ? w.name + ' \u00B7 ' + title : (w.name || title);
    return { text: text, tabs: w.tabCount != null ? plural(w.tabCount, 'tab') : '' };
  }

  // Hover text: the full title, then the app and why it is in this context.
  function windowTip(w) {
    return (String(w.title || '').trim() || 'Untitled') + '\n' + w.app + (w.why ? ' \u00B7 ' + w.why : '');
  }

  // Where a window is when it is not where it belongs: `home` is its context's desktop (or the one on screen).
  // `unsorted`: the window has no context, so it is only somewhere else, not waiting to be moved.
  function windowPlace(w, home, unsorted) {
    if (w.hidden) return 'hidden';
    if (typeof w.desktop === 'number' && home != null && w.desktop !== home) {
      return unsorted ? 'on Desktop ' + w.desktop : 'Desktop ' + w.desktop + ' \u00B7 not moved yet';
    }
    return '';
  }

  var STATUS_WORD = { working: 'Working', waiting: 'Waiting on you', idle: 'Idle', parked: 'Parked' };

  // The same three parts on every card: "Desktop N · ⌥N · Status".
  function cardMeta(c) {
    var desk = typeof c.desktop === 'number' ? 'Desktop ' + c.desktop
      : (c.key != null ? 'Desktop ' + c.key : 'No desktop');
    var key = c.key != null ? '\u2325' + c.key : 'no key';
    return [desk, key, STATUS_WORD[c.status] || 'Idle'].join(' \u00B7 ');
  }

  // One line for a card's agents, or '' when it has none: "2 agents · 1 waiting, 1 working · $0.10".
  function agentSummary(c) {
    var agents = c.agents || [];
    if (!agents.length) return '';
    var counts = {};
    var cost = 0;
    var hasCost = false;
    agents.forEach(function (a) {
      counts[a.status] = (counts[a.status] || 0) + 1;
      if (a.costToday != null) { cost += a.costToday; hasCost = true; }
    });
    var states = ['waiting', 'working', 'idle'].filter(function (k) { return counts[k]; });
    var state = agents.length === 1 ? agents[0].status
      : states.map(function (k) { return counts[k] + ' ' + k; }).join(', ');
    return [plural(agents.length, 'agent'), state].concat(hasCost ? ['$' + cost.toFixed(2)] : []).join(' \u00B7 ');
  }

  // Desktop 1…N like macOS Mission Control; contexts without a desktop fall back to their key, then go last.
  function byDesktop(list) {
    function rank(c) {
      if (typeof c.desktop === 'number') return c.desktop;
      return typeof c.key === 'number' ? c.key : Infinity;
    }
    return list.slice().sort(function (a, b) { return rank(a) - rank(b); });
  }

  // Which context the assign picker lists first: a tab suggestion for this window, else a context named in its title.
  function suggestedContextId(w, contexts, suggestions) {
    var hit = (suggestions || []).filter(function (s) { return s.fromWindowKey === w.key; })[0];
    if (hit && contexts.some(function (c) { return c.id === hit.toContextId; })) return hit.toContextId;
    var text = ((w.name || '') + ' ' + (w.title || '')).toLowerCase();
    var named = contexts.filter(function (c) { return c.name && text.indexOf(c.name.toLowerCase()) !== -1; });
    named.sort(function (a, b) { return b.name.length - a.name.length; });
    return named.length ? named[0].id : null;
  }

  // Layout presets. A card's select: '' follows the default, 'auto' is the automatic layout, else a preset id.
  function layoutOptions(layouts, defaultId) {
    var def = layouts.filter(function (p) { return p.id === defaultId; })[0];
    return [{ value: '', label: 'Default (' + (def ? def.name : 'auto') + ')' }, { value: 'auto', label: 'Auto' }]
      .concat(layouts.map(function (p) { return { value: p.id, label: p.name }; }));
  }

  function defaultLayoutOptions(layouts) {
    return [{ value: '', label: 'Auto' }].concat(layouts.map(function (p) { return { value: p.id, label: p.name }; }));
  }

  function layoutScreens(p) {
    var seen = {};
    p.slots.forEach(function (s) { seen[String(s.screen.uuid).toLowerCase()] = true; });
    return Object.keys(seen).length;
  }

  // "3 windows · 2 screens"; one screen is not mentioned.
  function layoutMeta(p) {
    var screens = layoutScreens(p);
    return plural(p.slots.length, 'window') + (screens > 1 ? ' \u00B7 ' + plural(screens, 'screen') : '');
  }

  var api = { sortLabel: sortLabel, strayHint: strayHint, moveResultText: moveResultText, tidyText: tidyText, noDataNote: noDataNote, windowLabel: windowLabel, windowParts: windowParts, windowTip: windowTip, windowPlace: windowPlace, cardMeta: cardMeta, agentSummary: agentSummary, shortTitle: shortTitle, byDesktop: byDesktop, suggestedContextId: suggestedContextId, desktopLabel: desktopLabel, toSortText: toSortText, setupSteps: setupSteps, needsSetup: needsSetup, failureText: failureText, busyLabel: busyLabel, doneText: doneText, canRename: canRename, moveItems: moveItems, layoutOptions: layoutOptions, defaultLayoutOptions: defaultLayoutOptions, layoutScreens: layoutScreens, layoutMeta: layoutMeta, UNSORTED_ID: UNSORTED_ID };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MCContextsLogic = api;
})(typeof window !== 'undefined' ? window : this);
