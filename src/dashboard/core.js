// ── Switchyard Dashboard: core ───────────────────────────────────────────
// Copyright 2026 Cyrus David Pastelero. Apache-2.0 License.
//
// State, agent tracking, DOM references, utilities, tooltip, WebSocket, header.
// Classic scripts sharing one global scope, loaded in order: core.js, activity.js, usage.js, app.js.

'use strict';

// ── State ─────────────────────────────────────────────────────────────────

var state = {
  agents: [],
  missions: [],
  events: [],
  connected: false,
  selectedAgentId: null,
  activePanel: 0,        // 0=agents, 1=missions, 2=timeline
  focusedRow: [0, 0, 0], // per-panel focused row index
  timelineFilter: null,  // agent id to filter by, or null for all
  securityEvents: [],    // security event log
  layerStatus: {},       // layer# -> 'ok'|'warn'|'critical'
};

var ws = null;
var reconnectTimer = null;
var RECONNECT_DELAY = 2000;
var eventCount = 0;
var startTime = Date.now();

// ── Deterministic agent color (hash-based, same agent = same color) ──────

var AGENT_COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
  '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff',
];

function hashString(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

function getAgentColor(agentId) {
  return AGENT_COLORS[hashString(agentId) % AGENT_COLORS.length];
}

// ── Stuck/loop detection ─────────────────────────────────────────────────

var STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
var agentLastSeen = {};    // agentId -> timestamp
var agentRecentTools = {}; // agentId -> [{ tool, input }, ...]

// ── File activity & diff tracking (from claude-squad / agent-farm) ────────

var agentFiles = {};      // agentId -> Set of file paths touched
var agentEditCount = {};  // agentId -> { added: N, removed: N }
var agentCurrentTool = {}; // agentId -> { tool, target } for live activity display

function trackAgentActivity(evt) {
  var aid = evt.agent_id || 'unknown';

  // Clear tracking on session end — prevents stale LOOP/STUCK badges
  if (evt.event_type === 'stop' || evt.event_type === 'Stop') {
    clearAgentTracking(aid);
    return;
  }

  agentLastSeen[aid] = Date.now();

  if (evt.tool_name) {
    if (!agentRecentTools[aid]) agentRecentTools[aid] = [];
    var inputKey = '';
    var input;
    try {
      input = typeof evt.tool_input === 'string' ? JSON.parse(evt.tool_input) : evt.tool_input;
      inputKey = JSON.stringify(input);
    } catch (e) {
      input = null;
      inputKey = String(evt.tool_input);
    }
    agentRecentTools[aid].push({ tool: evt.tool_name, input: inputKey });
    // Keep last 10
    if (agentRecentTools[aid].length > 10) {
      agentRecentTools[aid] = agentRecentTools[aid].slice(-10);
    }

    // Track files touched by this agent
    if (input && input.file_path) {
      if (!agentFiles[aid]) agentFiles[aid] = {};
      agentFiles[aid][input.file_path] = true;
    }

    // Track edit diffs (rough line count estimates)
    if (evt.tool_name === 'Edit' && input) {
      if (!agentEditCount[aid]) agentEditCount[aid] = { added: 0, removed: 0 };
      // The server stores line counts, not the edited text.
      agentEditCount[aid].removed += Number(input.removed_lines) || 0;
      agentEditCount[aid].added += Number(input.added_lines) || 0;
    } else if (evt.tool_name === 'Write' && input && input.added_lines) {
      if (!agentEditCount[aid]) agentEditCount[aid] = { added: 0, removed: 0 };
      agentEditCount[aid].added += Number(input.added_lines) || 0;
    }

    // Track current tool for live display
    var target = '';
    if (input) {
      if (input.file_path) target = input.file_path.split('/').pop();
      else if (input.command) target = input.command.length > 30 ? input.command.slice(0, 27) + '...' : input.command;
      else if (input.pattern) target = input.pattern;
    }
    agentCurrentTool[aid] = { tool: evt.tool_name, target: target };
  }
}

function getAgentFileCount(agentId) {
  return agentFiles[agentId] ? Object.keys(agentFiles[agentId]).length : 0;
}

function getAgentDiffStats(agentId) {
  return agentEditCount[agentId] || { added: 0, removed: 0 };
}

function getAgentCurrentActivity(agentId) {
  return agentCurrentTool[agentId] || null;
}

// Clear tracking data when a session ends — prevents stale LOOP/STUCK alerts
function clearAgentTracking(agentId) {
  delete agentRecentTools[agentId];
  delete agentCurrentTool[agentId];
  delete agentLastSeen[agentId];
}

function isAgentStuck(agentId) {
  var lastSeen = agentLastSeen[agentId];
  if (!lastSeen) return false;
  return (Date.now() - lastSeen) > STUCK_THRESHOLD_MS;
}

// Tools that are normal to call repeatedly — don't flag as loops.
// Only flag write tools (Edit, Write, Bash) that repeat with identical input.
var LOOP_IGNORE_TOOLS = {
  'Read': true, 'Grep': true, 'Glob': true,
  'Agent': true, 'SendMessage': true,
  'TaskCreate': true, 'TaskUpdate': true, 'TaskGet': true, 'TaskList': true,
  'WebSearch': true, 'WebFetch': true,
  'Skill': true, 'ToolSearch': true, 'LSP': true
};

function isAgentLooping(agentId) {
  var recent = agentRecentTools[agentId];
  if (!recent || recent.length < 3) return false;
  var last = recent[recent.length - 1];
  // Skip read-only tools — repeated reads are normal
  if (LOOP_IGNORE_TOOLS[last.tool]) return false;
  var count = 0;
  for (var i = recent.length - 1; i >= 0; i--) {
    if (recent[i].tool === last.tool && recent[i].input === last.input) {
      count++;
    } else {
      break;
    }
  }
  return count >= 3;
}

// ── Enhanced anti-pattern detection (inspired by agenttop) ───────────────

var MARATHON_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes continuous
var agentFirstSeen = {};      // agentId -> timestamp
var agentErrorCount = {};     // agentId -> count of recent errors
var agentCorrectionSpiral = {}; // agentId -> count of edit-then-re-edit same file

function trackAgentPatterns(evt) {
  var aid = evt.agent_id || 'unknown';

  // Track session start
  if (!agentFirstSeen[aid]) agentFirstSeen[aid] = Date.now();

  // Track errors (failed tool calls)
  if (evt.event_type === 'PostToolUse') {
    var output = evt.tool_output;
    if (typeof output === 'string') {
      try { output = JSON.parse(output); } catch (e) { /* ignore */ }
    }
    var isError = false;
    if (typeof output === 'object' && output !== null) {
      isError = output.error || output.stderr || output.is_error;
    } else if (typeof output === 'string') {
      isError = output.indexOf('Error') !== -1 || output.indexOf('error') !== -1;
    }
    if (isError) {
      agentErrorCount[aid] = (agentErrorCount[aid] || 0) + 1;
    }
  }

  // Track correction spirals (editing same file repeatedly)
  if (evt.tool_name === 'Edit' || evt.tool_name === 'Write') {
    var input = evt.tool_input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { /* ignore */ }
    }
    var filePath = input && input.file_path;
    if (filePath) {
      var recent = agentRecentTools[aid] || [];
      var editCount = 0;
      for (var i = recent.length - 1; i >= Math.max(0, recent.length - 6); i--) {
        if ((recent[i].tool === 'Edit' || recent[i].tool === 'Write') &&
            recent[i].input.indexOf(filePath) !== -1) {
          editCount++;
        }
      }
      if (editCount >= 3) {
        agentCorrectionSpiral[aid] = (agentCorrectionSpiral[aid] || 0) + 1;
      }
    }
  }
}

function isMarathonSession(agentId) {
  var first = agentFirstSeen[agentId];
  if (!first) return false;
  return (Date.now() - first) > MARATHON_THRESHOLD_MS;
}

function hasErrorBurst(agentId) {
  return (agentErrorCount[agentId] || 0) >= 5;
}

function hasCorrectionSpiral(agentId) {
  return (agentCorrectionSpiral[agentId] || 0) >= 2;
}

// ── Status dot characters ────────────────────────────────────────────────

var STATUS_DOTS = {
  active: '\u25CF',       // ● filled circle
  idle: '\u25CB',         // ○ empty circle
  disconnected: '\u25CC', // ◌ dotted circle
};

// ── DOM references ────────────────────────────────────────────────────────

var $agentCount = document.getElementById('agent-count');
var $missionCount = document.getElementById('mission-count');
var $eventCount = document.getElementById('event-count');
var $uptime = document.getElementById('uptime');
var $connectionStatus = document.getElementById('connection-status');
var $agentsList = document.getElementById('agents-list');
var $agentsBadge = document.getElementById('agents-badge');
var $missionsList = document.getElementById('missions-list');
var $missionsBadge = document.getElementById('missions-badge');
var $timelineList = document.getElementById('timeline-list');
var $timelineBadge = document.getElementById('timeline-badge');
var $timelineFilter = document.getElementById('timeline-filter');
var $commandInput = document.getElementById('command-input');
var $commandTarget = document.getElementById('command-target');
// Mission creation removed — missions are auto-created from agent activity
var $kbdHelp = document.getElementById('kbd-help');
var $securityBtn = document.getElementById('security-btn');
var $securityCount = document.getElementById('security-count');
var $securityOverlay = document.getElementById('security-overlay');
var $securityClose = document.getElementById('security-close');
var $securityLog = document.getElementById('security-log');
var $radarBlips = document.getElementById('radar-blips');
var $leftCol = document.getElementById('left-col');
var $rightCol = document.getElementById('right-col');
var $mobileTabs = document.getElementById('mobile-tabs');
var $mobAgentCount = document.getElementById('mob-agent-count');
var $mobMissionCount = document.getElementById('mob-mission-count');
var $mobEventCount = document.getElementById('mob-event-count');
var $mobUsageCount = document.getElementById('mob-usage-count');
var $usageList = document.getElementById('usage-list');
var $usageBadge = document.getElementById('usage-badge');

var panels = [
  document.getElementById('agents-panel'),
  document.getElementById('missions-panel'),
  document.getElementById('usage-panel'),
  document.getElementById('timeline-panel'),
];

// ── Utilities ─────────────────────────────────────────────────────────────

function formatTime(ts) {
  if (!ts) return '--:--:--';
  var d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0') + ':' +
         String(d.getSeconds()).padStart(2, '0');
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  var s = Math.floor(ms / 1000);
  var h = String(Math.floor(s / 3600)).padStart(2, '0');
  var m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  var sec = String(s % 60).padStart(2, '0');
  return h + ':' + m + ':' + sec;
}

function timeAgo(ts) {
  if (!ts) return '';
  var diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) diff = 0;
  var seconds = Math.floor(diff / 1000);
  if (seconds < 60) return seconds + 's ago';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return formatShortDate(ts);
}

// "3 Apr", or "3 Apr 2025" when it is not this year. Used for anything older than a week.
function formatShortDate(ts) {
  var d = new Date(ts);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var out = d.getDate() + ' ' + months[d.getMonth()];
  if (d.getFullYear() !== new Date().getFullYear()) out += ' ' + d.getFullYear();
  return out;
}

// Context window in tokens for a model id, or 0 when it can't be told.
function contextWindowFor(model) {
  var id = String(model || '').toLowerCase();
  if (!id) return 0;
  if (id.indexOf('[1m]') !== -1 || id.indexOf('opus-5') !== -1 || id.indexOf('sonnet-5') !== -1) return 1000000;
  if (/(opus|sonnet|haiku)-[34]/.test(id)) return 200000;
  return 0;
}

function elapsed(since) {
  if (!since) return '';
  var diff = Date.now() - new Date(since).getTime();
  if (diff >= 86400000) {
    var days = Math.floor(diff / 86400000);
    return days + 'd ' + Math.floor((diff % 86400000) / 3600000) + 'h';
  }
  return formatDuration(diff);
}

function createEl(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      if (key === 'className') el.className = attrs[key];
      else if (key === 'textContent') el.textContent = attrs[key];
      else if (key.indexOf('data-') === 0) el.setAttribute(key, attrs[key]);
      else if (key === 'style') el.setAttribute('style', attrs[key]);
      else if (key !== 'innerHTML') el[key] = attrs[key];
    });
  }
  if (children) {
    children.forEach(function (child) { if (child) el.appendChild(child); });
  }
  return el;
}

function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ── Toast notifications ───────────────────────────────────────────────────

function showToast(message) {
  var toast = createEl('div', { className: 'toast', textContent: message });
  document.body.appendChild(toast);
  // Trigger reflow for animation
  toast.offsetHeight;
  toast.classList.add('toast-visible');
  setTimeout(function () {
    toast.classList.remove('toast-visible');
    setTimeout(function () { toast.remove(); }, 300);
  }, 2500);
}

// ── Custom tooltip ─────────────────────────────────────────────────────────

var $tooltip = createEl('div', { className: 'custom-tooltip hidden' });
document.body.appendChild($tooltip);
var tooltipHideTimer = null;

function showTooltip(target) {
  var text = target.getAttribute('data-tooltip');
  if (!text) return;

  clearElement($tooltip);
  text.split('\n').forEach(function (line) {
    var parts = line.split(': ');
    var row = createEl('div', { className: 'tooltip-row' });
    if (parts.length >= 2) {
      row.appendChild(createEl('span', { className: 'tooltip-label', textContent: parts[0] + ':' }));
      row.appendChild(createEl('span', { className: 'tooltip-value', textContent: parts.slice(1).join(': ') }));
    } else {
      row.appendChild(createEl('span', { className: 'tooltip-value', textContent: line }));
    }
    $tooltip.appendChild(row);
  });

  // Position near the element
  var rect = target.getBoundingClientRect();
  var left = rect.right + 8;
  var top = rect.top;

  // If it would overflow right, show on left
  if (left + 280 > window.innerWidth) {
    left = rect.left - 288;
    if (left < 0) left = 8;
  }
  // If it would overflow bottom
  if (top + 160 > window.innerHeight) {
    top = window.innerHeight - 168;
  }

  $tooltip.style.left = left + 'px';
  $tooltip.style.top = top + 'px';
  $tooltip.classList.remove('hidden');
}

function hideTooltip() {
  $tooltip.classList.add('hidden');
}

// Capture-phase listeners on document also see the document itself, which has no closest().
function closestIn(node, selector) {
  return node && node.closest ? node.closest(selector) : null;
}

// Show on mouseenter of elements with data-tooltip
document.addEventListener('mouseenter', function (e) {
  var target = closestIn(e.target, '[data-tooltip]');
  if (target) {
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    showTooltip(target);
  }
}, true);

document.addEventListener('mouseleave', function (e) {
  var target = closestIn(e.target, '[data-tooltip]');
  if (target) {
    tooltipHideTimer = setTimeout(hideTooltip, 150);
  }
}, true);

// Keep tooltip visible when hovering the tooltip itself
$tooltip.addEventListener('mouseenter', function () {
  if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
});
$tooltip.addEventListener('mouseleave', function () {
  tooltipHideTimer = setTimeout(hideTooltip, 150);
});

// Mobile: show on tap, hide on tap elsewhere
document.addEventListener('touchstart', function (e) {
  var target = e.target.closest('[data-tooltip]');
  if (target) {
    showTooltip(target);
  } else if (!e.target.closest('.custom-tooltip')) {
    hideTooltip();
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────

var wsFailCount = 0;

function connectWebSocket() {
  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + location.host);

  ws.onopen = function () {
    state.connected = true;
    state.everConnected = true;
    wsFailCount = 0;
    renderConnectionStatus();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Fallback: also fetch via HTTP in case the initial WS messages were missed
    fetchAgentsHttp();
    fetchMissions();
  };

  ws.onclose = function (e) {
    state.connected = false;
    renderConnectionStatus();
    // Code 1008 = policy violation (auth rejected), or repeated failures = likely unauthorized
    wsFailCount++;
    if (wsFailCount === 1) {
      fetch('/api/contexts', { credentials: 'include' }).then(function (res) {
        if (res.status === 401) window.location.href = '/login';
      }).catch(function () { /* offline: keep retrying */ });
    }
    if (e.code === 1008 || wsFailCount >= 3) {
      window.location.href = '/login';
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = function () {};

  ws.onmessage = function (evt) {
    try { handleMessage(JSON.parse(evt.data)); } catch (e) {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connectWebSocket();
  }, RECONNECT_DELAY);
}

function handleMessage(msg) {
  switch (msg.type) {
    // ── Initial bulk loads ──
    case 'agents':
      state.agents = msg.data || [];
      renderAgents();
      if (usageData || tokenData) renderUsage(); // session rows show agent names
      // Force mobile layout refresh — on some mobile browsers the panel
      // doesn't repaint after WebSocket data arrives during initial load
      if (isMobile()) { setMobileTab(mobileActiveTab); }
      break;
    case 'events':
      state.events = msg.data || [];
      eventCount = state.events.length;
      state.events.forEach(function (e) { trackAgentActivity(e); trackAgentPatterns(e); });
      renderTimeline();
      // Also fetch missions on initial connect
      fetchMissions();
      break;
    case 'missions':
      state.missions = msg.data || [];
      renderMissions();
      break;

    // ── Incremental updates (server uses colon-separated types) ──
    case 'event:new':
    case 'event':
      state.events.push(msg.data);
      eventCount++;
      trackAgentActivity(msg.data);
      trackAgentPatterns(msg.data);
      scanForSecrets(msg.data);
      renderTimelineAppend(msg.data);
      scheduleUsageRefresh();
      break;
    case 'agent:update':
    case 'agent_update':
      // Clear stale alerts when agent disconnects
      if (msg.data && msg.data.status === 'disconnected') {
        clearAgentTracking(msg.data.id);
      }
      upsertAgent(msg.data);
      renderAgents();
      break;
    case 'mission:update':
    case 'mission_update':
      upsertMission(msg.data);
      renderMissions();
      break;
    case 'instruction:new':
      trackInstruction(msg.data);
      break;
    case 'instruction:delivered':
      markInstructionDelivered(msg.data);
      break;
    case 'security:event':
      handleSecurityEvent(msg.data);
      break;
    case 'contexts':
      if (window.MCContexts) window.MCContexts.onMessage(msg);
      break;
  }
  updateHeaderStats();
}

// Fetch missions via REST (server doesn't send them on WS connect)
function fetchAgentsHttp() {
  fetch('/api/agents', { credentials: 'include' })
    .then(function (res) { if (!res.ok) return []; return res.json(); })
    .then(function (agents) {
      if (Array.isArray(agents) && agents.length > 0) {
        state.agents = agents;
        renderAgents();
        if (usageData || tokenData) renderUsage();
        updateHeaderStats();
        if (isMobile()) { setMobileTab(mobileActiveTab); }
      }
    })
    .catch(function () {});
}

function fetchMissions() {
  fetch('/api/missions')
    .then(function (res) { return res.json(); })
    .then(function (missions) {
      if (Array.isArray(missions)) {
        state.missions = missions;
      } else if (missions && Array.isArray(missions.data)) {
        state.missions = missions.data;
      }
      renderMissions();
      updateHeaderStats();
    })
    .catch(function () {});
}

function upsertAgent(agent) {
  var idx = state.agents.findIndex(function (a) { return a.id === agent.id; });
  if (idx >= 0) state.agents[idx] = agent;
  else state.agents.push(agent);
}

function upsertMission(mission) {
  var idx = state.missions.findIndex(function (m) { return m.id === mission.id; });
  if (idx >= 0) state.missions[idx] = mission;
  else state.missions.push(mission);
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderConnectionStatus() {
  if (state.connected) {
    $connectionStatus.className = 'conn-status connected';
    $connectionStatus.querySelector('.conn-text').textContent = 'CONNECTED';
  } else if (!state.everConnected) {
    // First load: say we're on the way instead of flashing a red error.
    $connectionStatus.className = 'conn-status connecting';
    $connectionStatus.querySelector('.conn-text').textContent = 'CONNECTING';
  } else {
    $connectionStatus.className = 'conn-status disconnected';
    $connectionStatus.querySelector('.conn-text').textContent = 'DISCONNECTED';
  }
}

function updateHeaderStats() {
  var activeAgents = state.agents.filter(isRecentAgent).length;
  var openMissions = state.missions.filter(isOpenMission).length;
  $agentCount.textContent = activeAgents;
  $missionCount.textContent = openMissions;
  $eventCount.textContent = eventCount;
  // Mobile tab counts
  if ($mobAgentCount) $mobAgentCount.textContent = activeAgents;
  if ($mobMissionCount) $mobMissionCount.textContent = openMissions;
  if ($mobEventCount) $mobEventCount.textContent = eventCount;
}

function updateUptime() {
  $uptime.textContent = formatDuration(Date.now() - startTime);
}
