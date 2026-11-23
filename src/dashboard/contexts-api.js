// ── Contexts API layer ────────────────────────────────────────────────────────
// The only place that knows the contexts URLs and response shapes: request(), the
// `api` calls and normalize() (GET /api/contexts and the `contexts` WebSocket
// message -> view model). contexts.js reads them from window.MCContextsApi.

(function (root) {
  'use strict';

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

  root.MCContextsApi = { request: request, api: api, normalize: normalize };
})(window);
