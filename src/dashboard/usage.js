// ── Switchyard Dashboard: timeline and usage ─────────────────────────────
// Copyright 2026 Cyrus David Pastelero. Apache-2.0 License.
//
// Timeline panel and usage panel.
// Classic scripts sharing one global scope, loaded in order: core.js, activity.js, usage.js, app.js.

'use strict';

// ── Timeline panel ────────────────────────────────────────────────────────

// Smarter per-tool-type summary (inspired by disler's toolInfo pattern)
function getEventDetail(evt) {
  var input = evt.tool_input;
  if (!input) return evt.event_type === 'Stop' ? 'session ended' : '';
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch (e) { return ''; }
  }
  var toolName = evt.tool_name || '';

  // File tools: show last 2 path segments
  if (input.file_path) {
    var shortPath = input.file_path.split('/').slice(-2).join('/');
    if (toolName === 'Edit') return shortPath + ' (edit)';
    if (toolName === 'Write') return shortPath + ' (write)';
    return shortPath;
  }
  // Bash: show command, truncated
  if (input.command) {
    var cmd = input.command;
    if (input.description) return input.description;
    return cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
  }
  // Search tools
  if (input.pattern) {
    var search = input.pattern;
    if (input.path) search += ' in ' + input.path.split('/').pop();
    return search.length > 60 ? search.substring(0, 57) + '...' : search;
  }
  // Agent tool
  if (input.prompt) return (input.description || input.prompt.substring(0, 50) + '...');
  // Task tools
  if (input.description) return input.description;
  // SendMessage
  if (input.to) return '-> ' + input.to;
  // WebFetch/WebSearch
  if (input.url) return input.url.length > 60 ? input.url.substring(0, 57) + '...' : input.url;
  if (input.query) return input.query;
  // Skill
  if (input.skill) return input.skill;
  return '';
}

function getExpandedDetail(evt) {
  var parts = [];
  var input = evt.tool_input;
  if (input) {
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { /* keep string */ }
    }
    if (typeof input === 'object' && input !== null) {
      if (input.file_path) parts.push('File: ' + input.file_path);
      if (input.command) parts.push('Cmd: ' + input.command);
      if (input.pattern) parts.push('Pattern: ' + input.pattern);
      if (input.added_lines != null || input.removed_lines != null) {
        parts.push('Lines: +' + (Number(input.added_lines) || 0) + ' / -' + (Number(input.removed_lines) || 0));
      }
    }
  }
  var output = evt.tool_output;
  if (output) {
    if (typeof output === 'string') {
      try { output = JSON.parse(output); } catch (e) { /* keep string */ }
    }
    if (typeof output === 'string' && output.length > 0) {
      parts.push('Output: ' + output.slice(0, 200) + (output.length > 200 ? '...' : ''));
    } else if (typeof output === 'object' && output !== null) {
      if (output.error) parts.push('Error: ' + String(output.error).slice(0, 200));
      if (output.stderr) parts.push('Stderr: ' + String(output.stderr).slice(0, 200));
      if (output.preview) parts.push('Output: ' + String(output.preview).slice(0, 200));
      if (output.redacted && output.redacted.length) parts.push('Redacted: ' + output.redacted.join(', '));
    }
  }
  return parts.join('\n');
}

function buildTimelineRowEl(evt) {
  var agentLabel = evt.agent_id || 'unknown';

  // Filter check
  if (state.timelineFilter && agentLabel !== state.timelineFilter) return null;

  var color = getAgentColor(agentLabel);
  var toolName = evt.tool_name || evt.event_type || '';
  var detail = getEventDetail(evt);

  var timeEl = createEl('span', { className: 'timeline-time', textContent: formatTime(evt.timestamp) });
  var agentEl = createEl('span', { className: 'timeline-agent', style: 'color:' + color, textContent: agentLabel });
  var toolEl = createEl('span', { className: 'timeline-tool', textContent: toolName });
  var detailEl = createEl('span', { className: 'timeline-detail', textContent: detail });

  var row = createEl('div', { className: 'timeline-row' }, [timeEl, agentEl, toolEl, detailEl]);

  // Expandable: click, Enter or Space shows the full input/output
  if (evt.tool_input || evt.tool_output) {
    row.style.cursor = 'pointer';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', 'false');
    var toggle = function () {
      var existing = row.querySelector('.timeline-expanded');
      if (existing) {
        existing.remove();
        row.classList.remove('expanded');
        row.setAttribute('aria-expanded', 'false');
        return;
      }
      var expanded = getExpandedDetail(evt);
      if (expanded) {
        var expandEl = createEl('pre', { className: 'timeline-expanded', textContent: expanded });
        row.appendChild(expandEl);
        row.classList.add('expanded');
        row.setAttribute('aria-expanded', 'true');
        row.scrollIntoView({ block: 'nearest' });
      }
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
  }

  return row;
}

// An empty panel says what will appear there and what to do, not just "nothing".
function emptyState(title, hint) {
  var el = createEl('div', { className: 'empty-state' });
  el.appendChild(createEl('div', { className: 'empty-title', textContent: title }));
  el.appendChild(createEl('div', { className: 'empty-hint', textContent: hint }));
  return el;
}

function renderTimeline() {
  $timelineBadge.textContent = eventCount;
  clearElement($timelineList);

  if (state.events.length === 0) {
    $timelineList.appendChild(emptyState('No activity yet', 'Every tool call an agent makes is listed here as it happens.'));
    return;
  }

  var count = 0;
  state.events.forEach(function (evt) {
    var row = buildTimelineRowEl(evt);
    if (row) { $timelineList.appendChild(row); count++; }
  });

  if (count === 0) {
    $timelineList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No events match filter' }));
  }

  scrollTimelineToBottom();
}

function renderTimelineAppend(evt) {
  $timelineBadge.textContent = eventCount;

  var row = buildTimelineRowEl(evt);
  if (!row) return;

  var empty = $timelineList.querySelector('.empty-state');
  if (empty) empty.remove();

  $timelineList.appendChild(row);
  scrollTimelineToBottom();
}

function scrollTimelineToBottom() {
  $timelineList.scrollTop = $timelineList.scrollHeight;
}

function setTimelineFilter(agentId) {
  state.timelineFilter = agentId;
  if (agentId) {
    $timelineFilter.textContent = 'filter: ' + agentId + ' [x]';
    $timelineFilter.classList.remove('hidden');
  } else {
    // Clearing filter also deselects the agent and resets usage to global
    state.selectedAgentId = null;
    $timelineFilter.classList.add('hidden');
    $commandTarget.textContent = 'to: (select agent)';
    $commandInput.disabled = true;
    $commandInput.placeholder = 'Select an agent first';
    renderAgents();
    fetchUsage();
  }
  renderTimeline();
}

// ── Usage panel ───────────────────────────────────────────────────────────

var usageData = null;
var usageRefreshTimer = null;
var usagePeriodHours = 24;
var $periodTabs = document.getElementById('period-tabs');

function scheduleUsageRefresh() {
  if (usageRefreshTimer) return;
  usageRefreshTimer = setTimeout(function () {
    usageRefreshTimer = null;
    fetchUsage();
  }, 5000);
}

function setUsagePeriod(hours) {
  usagePeriodHours = hours;
  // Update tab active state
  if ($periodTabs) {
    var tabs = $periodTabs.querySelectorAll('.period-tab');
    tabs.forEach(function (tab) {
      if (parseInt(tab.getAttribute('data-hours'), 10) === hours) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });
  }
  fetchUsage();
}

// Period tab click handler
if ($periodTabs) {
  $periodTabs.addEventListener('click', function (e) {
    var tab = e.target.closest('.period-tab');
    if (!tab) return;
    var hours = parseInt(tab.getAttribute('data-hours'), 10);
    if (!isNaN(hours)) setUsagePeriod(hours);
  });
}

var tokenData = null;

function fetchUsage() {
  var usageUrl = '/api/usage?hours=' + usagePeriodHours;
  if (state.selectedAgentId) {
    usageUrl += '&agent=' + encodeURIComponent(state.selectedAgentId);
  }
  var tokenUrl = '/api/tokens?hours=' + usagePeriodHours;

  // Fetch both in parallel
  Promise.all([
    fetch(usageUrl).then(function (r) { return r.json(); }),
    fetch(tokenUrl).then(function (r) { return r.json(); }).catch(function () { return null; }),
  ]).then(function (results) {
    usageData = results[0];
    tokenData = results[1];
    renderUsage();
  }).catch(function () {});
}

function formatCost(amount) {
  if (amount >= 1) return '$' + amount.toFixed(2);
  if (amount >= 0.01) return '$' + amount.toFixed(3);
  return '$' + amount.toFixed(4);
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function renderUsage() {
  if (!usageData && !tokenData) return;

  // Prefer token data (real) over usage data (estimates)
  var hasTokens = tokenData && tokenData.totalCost > 0;
  var periodLabel = usageData && usageData.period === 'all' ? 'All Time' : (usageData ? usageData.period.toUpperCase() : '24H');

  var badgeText = hasTokens ? formatCost(tokenData.totalCost) : (usageData ? String(usageData.totalToolCalls) : '0');
  $usageBadge.textContent = badgeText;
  if ($mobUsageCount) $mobUsageCount.textContent = badgeText;
  clearElement($usageList);

  if (!hasTokens && (!usageData || usageData.totalToolCalls === 0)) {
    $usageList.appendChild(emptyState('No usage yet', 'Tool calls and cost show up here once an agent has worked.'));
    return;
  }

  // ── Summary stats ──
  var summary = createEl('div', { className: 'usage-summary' });

  if (hasTokens) {
    // Real token data from JSONL logs
    var tokenStats = [
      { value: formatCost(tokenData.totalCost), label: 'Cost (' + periodLabel + ')', cls: 'cost' },
      { value: formatTokens(tokenData.totalTokens), label: 'Tokens', cls: '' },
      { value: String(tokenData.totalMessages), label: 'Messages', cls: '' },
      { value: String(tokenData.totalSessions), label: 'Sessions', cls: '' },
      { value: tokenData.cacheHitRate + '%', label: 'Cache Hit', cls: 'cache' },
    ];
    tokenStats.forEach(function (s) {
      var valueClass = 'usage-stat-value' + (s.cls ? ' ' + s.cls : '');
      summary.appendChild(createEl('div', { className: 'usage-stat' }, [
        createEl('span', { className: valueClass, textContent: s.value }),
        createEl('span', { className: 'usage-stat-label', textContent: s.label }),
      ]));
    });
  } else {
    // Fallback: estimated from tool calls
    var summaryStats = [
      { value: formatCost(usageData.totalEstimatedCost), label: 'Est. Cost (' + periodLabel + ')', cls: 'cost' },
      { value: String(usageData.totalToolCalls), label: 'Tool Calls', cls: '' },
      { value: String(usageData.totalSessions || 0), label: 'Sessions', cls: '' },
      { value: String(usageData.uniqueAgents), label: 'Agents', cls: '' },
    ];
    summaryStats.forEach(function (s) {
      var valueClass = 'usage-stat-value' + (s.cls ? ' ' + s.cls : '');
      summary.appendChild(createEl('div', { className: 'usage-stat' }, [
        createEl('span', { className: valueClass, textContent: s.value }),
        createEl('span', { className: 'usage-stat-label', textContent: s.label }),
      ]));
    });
  }
  $usageList.appendChild(summary);

  // ── Context window health for active sessions (inspired by claude-hud) ──
  if (hasTokens && tokenData.activeSessions > 0) {
    var activeSessions = tokenData.sessions.filter(function (s) { return s.isActive; });
    if (activeSessions.length > 0) {
      var ctxSection = createEl('div', { className: 'usage-section' });
      ctxSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Active Sessions — Context Health' }));

      activeSessions.forEach(function (s) {
        var sid = s.sessionId.length > 10 ? s.sessionId.slice(0, 8) + '..' : s.sessionId;
        var modelShort = (s.model || 'unknown').replace('claude-', '');
        var windowSize = contextWindowFor(s.model);
        var used = s.contextWindowUsed || 0;
        var cells = [
          createEl('span', { className: 'ctx-label', textContent: sid, title: s.sessionId }),
          createEl('span', { className: 'ctx-model', textContent: modelShort, title: s.model || 'unknown model' }),
        ];
        if (windowSize) {
          // The server's percent assumes a 200K window, so recompute against the real one.
          var pct = Math.min(100, Math.round((used / windowSize) * 100));
          var colorClass = pct >= 85 ? 'ctx-danger' : pct >= 60 ? 'ctx-warning' : 'ctx-ok';
          var fill = createEl('div', { className: 'ctx-bar-fill ' + colorClass, style: 'width:' + pct + '%' });
          cells.push(
            createEl('div', { className: 'ctx-bar-track' }, [fill]),
            createEl('span', { className: 'ctx-pct ' + colorClass, textContent: pct + '%', title: 'of ' + formatTokens(windowSize) + ' window' }));
        } else {
          // Unknown window: show the count, no bar, no false alarm.
          cells.push(
            createEl('span', { className: 'ctx-bar-spacer ctx-unknown', textContent: 'window size unknown' }),
            createEl('span', { className: 'ctx-pct' }));
        }
        cells.push(createEl('span', { className: 'ctx-tokens', textContent: formatTokens(used) }));
        var row = createEl('div', { className: 'health-row' }, cells);
        ctxSection.appendChild(row);
      });
      $usageList.appendChild(ctxSection);
    }
  }

  // ── Token breakdown (real data) ──
  if (hasTokens) {
    var tokenSection = createEl('div', { className: 'usage-section' });
    tokenSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Token Breakdown' }));

    var tokenRows = [
      { label: 'Input', value: formatTokens(tokenData.totalInputTokens), cls: '' },
      { label: 'Output', value: formatTokens(tokenData.totalOutputTokens), cls: '' },
      { label: 'Cache Write', value: formatTokens(tokenData.totalCacheCreationTokens), cls: '' },
      { label: 'Cache Read', value: formatTokens(tokenData.totalCacheReadTokens), cls: 'cache' },
    ];
    tokenRows.forEach(function (r) {
      var valueClass = 'session-cost' + (r.cls ? ' ' + r.cls : '');
      tokenSection.appendChild(createEl('div', { className: 'session-row' }, [
        createEl('span', { className: 'session-label', textContent: r.label }),
        createEl('span', { className: valueClass, textContent: r.value }),
      ]));
    });
    $usageList.appendChild(tokenSection);

    // Model usage
    if (tokenData.models && tokenData.models.length > 0) {
      var modelSection = createEl('div', { className: 'usage-section' });
      modelSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Cost by Model' }));

      var maxModelCost = tokenData.models[0].cost || 0.001;
      tokenData.models.forEach(function (m) {
        var pct = Math.round((m.cost / maxModelCost) * 100);
        var modelName = m.model.replace('claude-', '');
        var fill = createEl('div', { className: 'usage-bar-fill', style: 'width:' + pct + '%' });
        var track = createEl('div', { className: 'usage-bar-track' }, [fill]);
        modelSection.appendChild(createEl('div', { className: 'usage-bar-row' }, [
          createEl('span', { className: 'usage-bar-label', textContent: modelName }),
          track,
          createEl('span', { className: 'usage-bar-count cost-count', textContent: formatCost(m.cost) }),
        ]));
      });
      $usageList.appendChild(modelSection);
    }
  }

  // ── Session costs (real data preferred) ──
  var sessionsList = hasTokens ? tokenData.sessions : (usageData ? usageData.sessionCosts : []);
  if (sessionsList && sessionsList.length > 0) {
    var sessionSection = createEl('div', { className: 'usage-section' });
    sessionSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Session Costs' }));

    sessionsList.slice(0, 8).forEach(function (s) {
      var sid = s.sessionId || s.session_id || '';
      var sessionLabel = sid.length > 10 ? sid.slice(0, 8) + '..' : sid;
      var sCost = s.cost !== undefined ? s.cost : (s.estimated_cost || 0);
      var sMessages = s.messageCount || s.tool_calls || 0;
      var sTime = s.lastTimestamp || s.last_event || '';
      var msgLabel = s.messageCount !== undefined ? sMessages + ' msgs' : sMessages + ' calls';

      var children = [
        createEl('span', { className: 'session-label', textContent: sessionLabel, title: sid }),
        createEl('span', { className: 'session-cost', textContent: formatCost(sCost) }),
        createEl('span', { className: 'session-meta', textContent: msgLabel }),
      ];
      if (s.model) {
        children.push(createEl('span', { className: 'session-meta', textContent: s.model.replace('claude-', '') }));
      }
      children.push(createEl('span', { className: 'session-time', textContent: timeAgo(sTime) }));

      sessionSection.appendChild(createEl('div', { className: 'session-row' }, children));
    });
    $usageList.appendChild(sessionSection);
  }

  // ── Daily costs (real data preferred) ──
  var dailyList = hasTokens ? tokenData.daily : (usageData ? usageData.dailyCosts : []);
  if (dailyList && dailyList.length > 0) {
    var dailySection = createEl('div', { className: 'usage-section' });
    var dailyTitle = 'Daily Costs (' + periodLabel + ')';
    dailySection.appendChild(createEl('div', { className: 'usage-section-title', textContent: dailyTitle }));

    var maxDailyCost = 0.001;
    dailyList.forEach(function (d) {
      var dCost = d.cost !== undefined ? d.cost : (d.estimated_cost || 0);
      if (dCost > maxDailyCost) maxDailyCost = dCost;
    });

    dailyList.forEach(function (d) {
      var dCost = d.cost !== undefined ? d.cost : (d.estimated_cost || 0);
      var pct = Math.round((dCost / maxDailyCost) * 100);
      var fill = createEl('div', { className: 'usage-bar-fill daily', style: 'width:' + pct + '%' });
      var track = createEl('div', { className: 'usage-bar-track' }, [fill]);
      var dateLabel = d.date.slice(5);
      dailySection.appendChild(createEl('div', { className: 'usage-bar-row' }, [
        createEl('span', { className: 'usage-bar-label', textContent: dateLabel }),
        track,
        createEl('span', { className: 'usage-bar-count cost-count', textContent: formatCost(dCost) }),
      ]));
    });
    $usageList.appendChild(dailySection);
  }

  // ── Tool usage bars (from hook events) ──
  if (usageData && usageData.toolUsage && usageData.toolUsage.length > 0) {
    var toolSection = createEl('div', { className: 'usage-section' });
    toolSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Top Tools' }));

    var maxToolCount = usageData.toolUsage[0].count;
    usageData.toolUsage.slice(0, 10).forEach(function (t) {
      var pct = Math.round((t.count / maxToolCount) * 100);
      var fill = createEl('div', { className: 'usage-bar-fill', style: 'width:' + pct + '%' });
      var track = createEl('div', { className: 'usage-bar-track' }, [fill]);
      toolSection.appendChild(createEl('div', { className: 'usage-bar-row' }, [
        createEl('span', { className: 'usage-bar-label', textContent: t.tool_name }),
        track,
        createEl('span', { className: 'usage-bar-count', textContent: String(t.count) }),
      ]));
    });
    $usageList.appendChild(toolSection);
  }

  // ── Hourly activity sparkline ──
  if (usageData && usageData.hourlyActivity && usageData.hourlyActivity.length > 0) {
    var activitySection = createEl('div', { className: 'usage-section' });
    activitySection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Activity (24h)' }));

    var activityRow = createEl('div', { className: 'usage-activity-row' });
    var maxHourly = 1;
    usageData.hourlyActivity.forEach(function (h) {
      if (h.count > maxHourly) maxHourly = h.count;
    });
    usageData.hourlyActivity.forEach(function (h) {
      var heightPct = Math.max(2, Math.round((h.count / maxHourly) * 100));
      activityRow.appendChild(createEl('div', {
        className: 'usage-activity-bar',
        style: 'height:' + heightPct + '%',
        title: h.hour.slice(11, 16) + ' — ' + h.count + ' events',
      }));
    });
    activitySection.appendChild(activityRow);
    $usageList.appendChild(activitySection);
  }
}

