// ── Switchyard Dashboard ─────────────────────────────────────────────────
// Copyright 2026 Cyrus David Pastelero. Apache-2.0 License.
// https://github.com/cyruspastelero/switchyard
//
// Plain JS, no build step, no framework. Direct DOM manipulation for sub-100ms renders.
// Classic scripts sharing one global scope, loaded in order: core.js, activity.js, usage.js, app.js.
// This file runs last: keyboard, mobile tabs, collapsing, security bridge, notifications, start-up.

'use strict';

// ── Panel focus ───────────────────────────────────────────────────────────

function setActivePanel(index) {
  state.activePanel = index;
  panels.forEach(function (p, i) {
    if (i === index) p.classList.add('active-panel');
    else p.classList.remove('active-panel');
  });
  renderAgents();
  renderMissions();
}

function cyclePanels(direction) {
  setActivePanel((state.activePanel + direction + panels.length) % panels.length);
}

function navigateRows(direction) {
  var panelIdx = state.activePanel;
  var listLength = panelIdx === 0 ? state.agents.length : panelIdx === 1 ? state.missions.length : 0;
  if (listLength === 0) return;

  var list = panelIdx === 0 ? $agentsList : $missionsList;
  var hadFocus = list.contains(document.activeElement);
  state.focusedRow[panelIdx] = Math.max(0, Math.min(listLength - 1, state.focusedRow[panelIdx] + direction));
  if (panelIdx === 0) renderAgents();
  else renderMissions();
  // When a row has keyboard focus, j/k move that focus too, not only the highlight.
  var target = hadFocus && list.querySelector('.focused [tabindex="0"]');
  if (target) target.focus();
}

function selectFocusedRow() {
  if (state.activePanel === 0 && state.agents.length > 0) {
    var agent = state.agents[state.focusedRow[0]];
    state.selectedAgentId = agent.id;
    $commandTarget.textContent = 'to: ' + (agent.name || agent.agent_id || agent.id);
    $commandInput.disabled = false;
    $commandInput.placeholder = 'Type instruction...';
    renderAgents();
    // Filter timeline and usage to this agent
    setTimelineFilter(agent.agent_id || agent.id);
    fetchUsage();
  } else if (state.activePanel === 1 && state.missions.length > 0) {
    var mission = state.missions[state.focusedRow[1]];
    if (!mission) return;
    expandedMissionId = expandedMissionId === mission.id ? null : mission.id;
    renderMissions();
  }
}

// Tabbing into a panel makes it the panel that j/k/Enter act on.
panels.forEach(function (panel, i) {
  panel.addEventListener('focusin', function () {
    if (state.activePanel !== i) setActivePanel(i);
  });
});

// ── Inline mission creation ──────────────────────────────────────────────

// ── Instruction tracking ─────────────────────────────────────────────────
// Show sent instructions with delivery status so user knows if agent received them.

var sentInstructions = []; // { id, message, status, target_agent_id, created_at }
var MAX_INSTRUCTION_LOG = 5;

function trackInstruction(instr) {
  sentInstructions.unshift({
    id: instr.id,
    message: instr.message,
    status: 'pending',
    target: instr.target_agent_id,
    time: instr.created_at || new Date().toISOString(),
  });
  if (sentInstructions.length > MAX_INSTRUCTION_LOG) sentInstructions.pop();
  renderInstructionLog();
}

function markInstructionDelivered(instr) {
  var found = sentInstructions.find(function (s) { return s.id === instr.id; });
  if (found) {
    found.status = 'delivered';
    renderInstructionLog();
    showToast('\u2713 Agent received: "' + found.message.slice(0, 40) + (found.message.length > 40 ? '...' : '') + '"');
  }
}

function renderInstructionLog() {
  var $log = document.getElementById('instruction-log');
  if (!$log) return;
  clearElement($log);

  if (sentInstructions.length === 0) return;

  sentInstructions.forEach(function (instr) {
    var statusText = instr.status === 'delivered' ? '\u2713 delivered' : '\u25CB pending...';
    var statusClass = 'instr-status ' + instr.status;

    var row = createEl('div', { className: 'instr-log-row' }, [
      createEl('span', { className: statusClass, textContent: statusText }),
      createEl('span', { className: 'instr-msg', textContent: instr.message.length > 50 ? instr.message.slice(0, 47) + '...' : instr.message }),
      createEl('span', { className: 'instr-time', textContent: formatTime(instr.time) }),
    ]);
    $log.appendChild(row);
  });
}

// ── Instruction sending ──────────────────────────────────────────────────

function sendInstruction() {
  var message = $commandInput.value.trim();
  if (!message || !state.selectedAgentId) return;

  fetch('/api/instructions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_agent_id: state.selectedAgentId,
      message: message,
    }),
  })
    .then(function (res) {
      if (res.ok) {
        $commandInput.value = '';
        showToast('Instruction sent');
      } else {
        return res.json().then(function (body) {
          showToast('Error: ' + (body.error || 'Failed'));
        });
      }
    })
    .catch(function () { showToast('Failed to send instruction'); });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────

document.addEventListener('keydown', function (e) {
  var tag = (e.target && e.target.tagName) ? e.target.tagName : '';
  var isInput = tag === 'INPUT' || tag === 'TEXTAREA';

  // Input-specific handlers
  if (isInput) {
    if (e.key === 'Escape') {
      e.target.blur();
    }
    // Only the command input is ours; Enter in a form field (Contexts view) must still submit its form.
    if (e.key === 'Enter' && e.target === $commandInput) {
      e.preventDefault();
      sendInstruction();
    }
    return;
  }

  // Contexts view has its own focusable controls: leave Tab and arrows alone.
  if (document.body.classList.contains('view-contexts') && e.key !== '?' && e.key !== 'Escape') return;

  // A focused button, link or row handles its own Enter and Space; Tab stays native.
  var onControl = tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' ||
    (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'button');

  // Global shortcuts
  switch (e.key) {
    case ']':
      e.preventDefault();
      cyclePanels(1);
      break;
    case '[':
      e.preventDefault();
      cyclePanels(-1);
      break;
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      navigateRows(1);
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      navigateRows(-1);
      break;
    case 'Enter':
      if (!onControl) selectFocusedRow();
      break;
    case 'i':
      e.preventDefault();
      if (state.selectedAgentId) $commandInput.focus();
      break;
    case '/':
      e.preventDefault();
      // Toggle timeline filter off
      if (state.timelineFilter) setTimelineFilter(null);
      break;
    case '?':
      e.preventDefault();
      toggleHelp();
      break;
    case 'Escape':
      if (!$kbdHelp.classList.contains('hidden')) toggleHelp();
      if (state.timelineFilter) setTimelineFilter(null);
      break;
  }
});

// ── Click handlers ────────────────────────────────────────────────────────

$agentsList.addEventListener('click', function (e) {
  var row = e.target.closest('[data-agent-id]');
  if (!row) return;
  var agentId = row.getAttribute('data-agent-id');
  state.selectedAgentId = agentId;
  var agent = state.agents.find(function (a) { return a.id === agentId; });
  if (agent) {
    $commandTarget.textContent = 'to: ' + (agent.name || agent.agent_id || agent.id);
    $commandInput.disabled = false;
    $commandInput.placeholder = 'Type instruction...';
    setTimelineFilter(agent.agent_id || agent.id);
  }
  renderAgents();
  renderMissions();
  fetchUsage();
});

$timelineFilter.addEventListener('click', function () {
  setTimelineFilter(null);
});

$kbdHelp.addEventListener('click', function (e) {
  if (e.target === $kbdHelp) $kbdHelp.classList.add('hidden');
});

// ? Help button: a real button, so keyboard users can open it too. Focus moves into the dialog and back.
var $kbdHint = document.querySelector('.kbd-hint');
function toggleHelp() {
  var opening = $kbdHelp.classList.contains('hidden');
  $kbdHelp.classList.toggle('hidden');
  var content = $kbdHelp.querySelector('.kbd-content');
  if (opening && content) content.focus();
  else if (!opening && $kbdHint) $kbdHint.focus();
}
if ($kbdHint) $kbdHint.addEventListener('click', toggleHelp);
// Modal dialogs keep Tab inside them (Tab is native everywhere else).
function trapTab(dialog) {
  if (!dialog) return;
  dialog.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var items = Array.prototype.filter.call(
      dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex="0"]'),
      function (el) { return !el.disabled && el.offsetParent !== null; });
    if (items.length === 0) return;
    var first = items[0];
    var last = items[items.length - 1];
    var inList = items.indexOf(document.activeElement) !== -1;
    if (e.shiftKey && (document.activeElement === first || !inList)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inList)) { e.preventDefault(); first.focus(); }
  });
}
trapTab($kbdHelp);
trapTab($securityOverlay);

// A visible close button: phones have no Esc key.
var $kbdClose = $kbdHelp.querySelector('.kbd-close');
if ($kbdClose) $kbdClose.addEventListener('click', toggleHelp);

// ── Mobile tab navigation ─────────────────────────────────────────────────

var mobileActiveTab = 'contexts'; // Contexts is home

function isMobile() {
  return window.innerWidth <= 640;
}

window.MCSetMobileTabName = function (name) {
  mobileActiveTab = name;
  document.querySelectorAll('.mobile-tab').forEach(function (tab) {
    tab.classList.toggle('active', tab.getAttribute('data-tab') === name);
  });
};

function setMobileTab(tabName) {
  mobileActiveTab = tabName;
  if (window.MCContexts) window.MCContexts.setView(tabName === 'contexts' ? 'contexts' : 'overview');

  // Update tab buttons
  var tabs = document.querySelectorAll('.mobile-tab');
  tabs.forEach(function (tab) {
    if (tab.getAttribute('data-tab') === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Show/hide columns
  if (tabName === 'contexts') {
    return; // the Contexts view replaces the main grid (see styles.css)
  }
  if (tabName === 'agents') {
    $leftCol.classList.add('mobile-visible');
    $rightCol.classList.remove('mobile-visible');
    panels[1].style.display = '';
    panels[2].style.display = '';
    panels[3].style.display = '';
  } else if (tabName === 'missions') {
    $leftCol.classList.remove('mobile-visible');
    $rightCol.classList.add('mobile-visible');
    panels[1].style.display = '';
    panels[2].style.display = 'none';
    panels[3].style.display = 'none';
  } else if (tabName === 'usage') {
    $leftCol.classList.remove('mobile-visible');
    $rightCol.classList.add('mobile-visible');
    panels[1].style.display = 'none';
    panels[2].style.display = '';
    panels[3].style.display = 'none';
  } else if (tabName === 'timeline') {
    $leftCol.classList.remove('mobile-visible');
    $rightCol.classList.add('mobile-visible');
    panels[1].style.display = 'none';
    panels[2].style.display = 'none';
    panels[3].style.display = '';
  }
}

// Tab click handlers
if ($mobileTabs) {
  $mobileTabs.addEventListener('click', function (e) {
    var tab = e.target.closest('.mobile-tab');
    if (!tab) return;
    var tabName = tab.getAttribute('data-tab');
    if (tabName) setMobileTab(tabName);
  });
}

// Handle resize: reset mobile state when going to desktop
function handleResize() {
  if (!isMobile()) {
    $leftCol.classList.remove('mobile-visible');
    $rightCol.classList.remove('mobile-visible');
    panels[1].style.display = '';
    panels[2].style.display = '';
    panels[3].style.display = '';
  } else {
    setMobileTab(mobileActiveTab);
  }
}

window.addEventListener('resize', handleResize);

// ── Collapsible panels ────────────────────────────────────────────────────

var COLLAPSE_KEY = 'switchyard_collapsed';
var OLD_COLLAPSE_KEY = 'mc_collapsed';

function loadCollapsedState() {
  try { var s = localStorage.getItem(COLLAPSE_KEY) || localStorage.getItem(OLD_COLLAPSE_KEY); return s ? JSON.parse(s) : {}; }
  catch (e) { return {}; }
}

function saveCollapsedState(cs) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(cs)); } catch (e) {}
}

var collapsedPanels = loadCollapsedState();

function applyCollapsedState() {
  document.querySelectorAll('.panel[data-panel]').forEach(function (panel) {
    var id = panel.getAttribute('data-panel');
    if (collapsedPanels[id]) panel.classList.add('collapsed');
  });
}

document.addEventListener('click', function (e) {
  var header = e.target.closest('.panel-header');
  if (!header) return;
  var panel = header.closest('.panel[data-panel]');
  if (!panel) return;
  // Don't collapse when clicking interactive elements inside header
  if (e.target.closest('button, input, .period-tab, .timeline-filter')) return;
  var id = panel.getAttribute('data-panel');
  panel.classList.toggle('collapsed');
  collapsedPanels[id] = panel.classList.contains('collapsed');
  saveCollapsedState(collapsedPanels);
});

applyCollapsedState();

// ── Security bridge ──────────────────────────────────────────────────────
// handleSecurityEvent is called from handleMessage for server-sent events.
// security.js overrides MC.handleSecurityEvent for full processing.
// This stub exists so the WS handler doesn't error before security.js loads.

function handleSecurityEvent(evt) {
  if (window.Switchyard && window.Switchyard.handleSecurityEvent) {
    window.Switchyard.handleSecurityEvent(evt);
  }
}

// Expose API for security.js module
window.Switchyard = {
  showToast: showToast,
  formatTime: formatTime,
  createEl: createEl,
  clearElement: clearElement,
  trackAgentActivity: trackAgentActivity,
  handleSecurityEvent: null, // set by security.js
  scanToolEvent: null,       // set by security.js
};

// Hook Layer 7 scanning into event stream once security.js loads
var _origTrack = trackAgentActivity;
trackAgentActivity = function (evt) {
  _origTrack(evt);
  if (window.Switchyard && window.Switchyard.scanToolEvent) {
    window.Switchyard.scanToolEvent(evt);
  }
};

// ── Browser notifications (from disler) ────────────────────────────────

var notificationsEnabled = false;
var notifiedAgents = {}; // agentId -> last notification type

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(function (perm) {
      notificationsEnabled = (perm === 'granted');
    });
  } else {
    notificationsEnabled = (Notification.permission === 'granted');
  }
}

function notifyAgentIssue(agentId, issue) {
  if (!notificationsEnabled) return;
  if (notifiedAgents[agentId] === issue) return; // don't spam
  notifiedAgents[agentId] = issue;
  try {
    var n = new Notification('Agent Alert: ' + issue, {
      body: 'Agent ' + agentId + ' — ' + issue,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚠️</text></svg>',
      requireInteraction: true,
    });
    n.onclick = function () { window.focus(); n.close(); };
    // Auto-close after 15s
    setTimeout(function () { n.close(); }, 15000);
  } catch (e) { /* ignore */ }
}

// Check agents for issues and fire notifications
function checkAgentNotifications() {
  state.agents.forEach(function (agent) {
    if (agent.status !== 'active') return;
    if (isAgentStuck(agent.id)) {
      notifyAgentIssue(agent.id, 'STUCK — no activity');
    } else if (isAgentLooping(agent.id)) {
      notifyAgentIssue(agent.id, 'LOOP detected');
    } else if (hasCorrectionSpiral(agent.id)) {
      notifyAgentIssue(agent.id, 'Correction spiral');
    } else if (hasErrorBurst(agent.id)) {
      notifyAgentIssue(agent.id, 'Error burst (5+ failures)');
    } else {
      delete notifiedAgents[agent.id]; // Clear when resolved
    }
  });
}

// ── Visibility-aware polling (from builderz) ──────────────────────────

var tabVisible = true;
var pendingRefreshOnVisible = false;

document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    tabVisible = false;
  } else {
    tabVisible = true;
    if (pendingRefreshOnVisible) {
      pendingRefreshOnVisible = false;
      renderAgents();
      fetchUsage();
    }
  }
});

// ── Secret scanner (from builderz) ────────────────────────────────────

var secretAlerts = []; // { agentId, secretType, timestamp }

// The server replaces secrets before storing an event and names what it replaced.
function scanForSecrets(evt) {
  if (!evt.tool_output) return;
  var output = evt.tool_output;
  if (typeof output === 'string') {
    try { output = JSON.parse(output); } catch (e) { return; }
  }
  var kinds = output && Array.isArray(output.redacted) ? output.redacted : [];
  if (kinds.length === 0) return;
  secretAlerts.push({
    agentId: evt.agent_id || 'unknown',
    secretType: String(kinds[0]),
    timestamp: evt.timestamp || new Date().toISOString(),
  });
  // Keep last 50 alerts
  if (secretAlerts.length > 50) secretAlerts.shift();
  showToast('SECRET DETECTED: ' + String(kinds[0]) + ' in tool output (redacted before storing)');
}

// ── Initialize ────────────────────────────────────────────────────────────

renderConnectionStatus();
updateHeaderStats();
setActivePanel(0);
// A page restored from cache after a server restart has no valid session; go to login right away.
fetch('/api/contexts', { credentials: 'include' }).then(function (res) {
  if (res.status === 401) window.location.href = '/login';
}).catch(function () { /* server unreachable: the connection badge already says so */ });
connectWebSocket();
fetchUsage();
requestNotificationPermission();

// Set initial mobile state
if (isMobile()) {
  setMobileTab(mobileActiveTab);
}

// Uptime counter — update every second
setInterval(updateUptime, 1000);

// Refresh agent displays every 10s (time-ago + stuck detection)
// Visibility-aware: skip when tab is hidden
setInterval(function () {
  if (tabVisible) {
    renderAgents();
    checkAgentNotifications();
  } else {
    pendingRefreshOnVisible = true;
  }
}, 10000);

// Refresh usage stats every 30s (visibility-aware)
setInterval(function () {
  if (tabVisible) {
    fetchUsage();
  } else {
    pendingRefreshOnVisible = true;
  }
}, 30000);
