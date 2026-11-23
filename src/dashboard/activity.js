// ── Switchyard Dashboard: activity ───────────────────────────────────────
// Copyright 2026 Cyrus David Pastelero. Apache-2.0 License.
//
// Agents panel (tree hierarchy) and missions panel.
// Classic scripts sharing one global scope, loaded in order: core.js, activity.js, usage.js, app.js.

'use strict';

// ── Agents panel (tree hierarchy) ──────────────────────────────────────────

// Clean display name: strip UUIDs, show meaningful label
function agentDisplayName(agent) {
  // Prefer server-derived name (from agent-tracker.ts)
  if (agent.name) return agent.name;
  // Use project folder from cwd
  if (agent.cwd) {
    var project = agent.cwd.split('/').filter(Boolean).pop();
    if (project) return project;
  }
  // Subagent with readable agent_id
  var aid = agent.agent_id || '';
  if (aid && !isMainAgentId(aid) && aid.length <= 16) return aid;
  if (aid && !isMainAgentId(aid)) return 'Sub-' + aid.slice(0, 8);
  // Main agent without cwd — just show "Agent"
  return 'Agent';
}

// Agent filter: 'active' (seen in the last 24 h, the default), 'idle' (same window), 'all'.
var RECENT_MS = 24 * 3600 * 1000;
var agentFilter = 'active';

function isRecentAgent(agent) {
  if (agent.status === 'active') return true;
  var seen = agent.last_seen_at ? new Date(agent.last_seen_at).getTime() : NaN;
  return !isNaN(seen) && Date.now() - seen < RECENT_MS;
}

function matchesAgentFilter(agent) {
  if (agentFilter === 'all') return true;
  if (agentFilter === 'idle') return agent.status === 'idle' && isRecentAgent(agent);
  return isRecentAgent(agent);
}

function isOpenMission(m) { return (m.status || 'queued') !== 'completed'; }

// Wire up filter buttons
var $agentFilters = document.getElementById('agent-filters');
if ($agentFilters) {
  $agentFilters.addEventListener('click', function (e) {
    // Clear old agents button
    var clearBtn = e.target.closest('.agent-clear-btn');
    if (clearBtn) {
      e.stopPropagation();
      fetch('/api/agents/disconnected', { method: 'DELETE', credentials: 'include' })
        .then(function (res) {
          if (res.status === 401) { window.location.href = '/login'; return null; }
          return res.json();
        })
        .then(function (data) {
          if (!data) return;
          var count = data.deleted || 0;
          if (count === 0) { showToast('No disconnected agents'); return; }
          // Remove from local state
          state.agents = state.agents.filter(function (a) { return a.status !== 'disconnected'; });
          renderAgents();
          updateHeaderStats();
          showToast('Cleared ' + count + ' old agent' + (count !== 1 ? 's' : ''));
        })
        .catch(function () { showToast('Failed to clear agents'); });
      return;
    }

    var btn = e.target.closest('.agent-filter-btn');
    if (!btn) return;
    e.stopPropagation();
    var filter = btn.getAttribute('data-filter');
    if (!filter) return;
    agentFilter = filter;
    $agentFilters.querySelectorAll('.agent-filter-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-filter') === filter);
    });
    renderAgents();
  });
}

// The server stores a main agent's agent_id as "<session>:main"; older rows have a bare "main".
function isMainAgentId(aid) {
  return aid === 'main' || /:main$/.test(aid);
}

function buildAgentTree() {
  var sessions = {};
  var orphans = [];
  state.agents.forEach(function (agent) {
    var sid = agent.session_id || '';
    var aid = agent.agent_id || 'main';
    if (!sid) { orphans.push(agent); return; }
    if (!sessions[sid]) sessions[sid] = { main: null, subs: [] };
    if (isMainAgentId(aid)) sessions[sid].main = agent;
    else sessions[sid].subs.push(agent);
  });
  return { sessions: sessions, orphans: orphans };
}

function buildAgentRow(agent, isSub, isLast, flatIdx) {
  var statusClass = agent.status || 'active';
  var name = agentDisplayName(agent);
  var focused = (state.activePanel === 0 && state.focusedRow[0] === flatIdx);
  var selected = (state.selectedAgentId === agent.id);
  var rowClass = 'agent-row' + (focused ? ' focused' : '') + (selected ? ' selected' : '') + (isSub ? ' subagent' : ' main-agent');

  var dotChar = STATUS_DOTS[statusClass] || STATUS_DOTS.disconnected;
  var dot = createEl('span', { className: 'agent-dot ' + statusClass, textContent: dotChar });
  var nameEl = createEl('span', { className: 'agent-name', textContent: name });
  var timeEl = createEl('span', { className: 'agent-time', textContent: timeAgo(agent.last_seen_at) });

  var topChildren = [dot, nameEl];

  // Sub-count badge (clickable toggle) for main agents with children
  if (!isSub && agent._subCount > 0) {
    var chevron = agent._sessionCollapsed ? '\u25B8' : '\u25BE'; // ▸ or ▾
    var toggleEl = createEl('span', {
      className: 'agent-sub-toggle',
      textContent: chevron + ' ' + agent._subCount + ' sub'
    });
    topChildren.push(toggleEl);
  }

  // Alert badges
  if (statusClass === 'active' && isAgentStuck(agent.id)) {
    topChildren.push(createEl('span', { className: 'agent-alert stuck', textContent: '! STUCK' }));
  } else if (isAgentLooping(agent.id)) {
    topChildren.push(createEl('span', { className: 'agent-alert loop', textContent: '! LOOP' }));
  } else if (typeof hasCorrectionSpiral === 'function' && hasCorrectionSpiral(agent.id)) {
    topChildren.push(createEl('span', { className: 'agent-alert spiral', textContent: '! SPIRAL' }));
  } else if (typeof hasErrorBurst === 'function' && hasErrorBurst(agent.id)) {
    topChildren.push(createEl('span', { className: 'agent-alert errors', textContent: '! ERRORS' }));
  } else if (typeof isMarathonSession === 'function' && isMarathonSession(agent.id)) {
    topChildren.push(createEl('span', { className: 'agent-alert marathon', textContent: 'MARATHON' }));
  }

  topChildren.push(timeEl);
  var topRow = createEl('div', { className: 'agent-row-top' }, topChildren);
  var children = [topRow];

  // Show short project path (not full /Users/cyrus/...) when selected
  if (selected && agent.cwd) {
    var parts = agent.cwd.split('/').filter(Boolean);
    var shortCwd = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : agent.cwd;
    children.push(createEl('div', { className: 'agent-activity cwd', textContent: shortCwd }));
  }

  // Live activity line — show current tool + target
  var currentAct = getAgentCurrentActivity(agent.id);
  var activity = '';
  if (statusClass === 'active' && isAgentStuck(agent.id)) {
    activity = 'no activity for ' + timeAgo(agent.last_seen_at) + ' — check terminal';
  } else if (currentAct && statusClass === 'active') {
    activity = currentAct.tool + (currentAct.target ? ' ' + currentAct.target : '');
  } else if (statusClass === 'idle') {
    activity = 'idle ' + timeAgo(agent.last_seen_at);
  } else if (agent.current_tool) {
    activity = agent.current_tool;
  }
  if (activity) {
    children.push(createEl('div', { className: 'agent-activity', textContent: activity }));
  }

  // Stats line — diff stats, files touched, session duration
  var diff = getAgentDiffStats(agent.id);
  var fileCount = getAgentFileCount(agent.id);
  var statParts = [];
  if (diff.added > 0 || diff.removed > 0) {
    statParts.push('+' + diff.added + ' -' + diff.removed);
  }
  if (fileCount > 0) {
    statParts.push(fileCount + ' file' + (fileCount !== 1 ? 's' : ''));
  }
  if (agent.first_seen_at) {
    statParts.push(elapsed(agent.first_seen_at));
  }
  if (statParts.length > 0) {
    children.push(createEl('div', { className: 'agent-stats', textContent: statParts.join('  ·  ') }));
  }

  // Quick-action buttons (visible on hover)
  var quickActions = createEl('div', { className: 'agent-quick-actions' });

  if (agent.cwd) {
    var copyPathBtn = createEl('button', { className: 'agent-quick-btn', textContent: '\u2398 Copy Path' });
    (function (cwd) {
      copyPathBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        navigator.clipboard.writeText(cwd).then(function () {
          showToast('Copied: ' + cwd);
        }).catch(function () {
          // Fallback for non-HTTPS
          var ta = document.createElement('textarea');
          ta.value = cwd;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          showToast('Copied: ' + cwd);
        });
      });
    })(agent.cwd);
    quickActions.appendChild(copyPathBtn);
  }

  if (agent.session_id) {
    var copyIdBtn = createEl('button', { className: 'agent-quick-btn', textContent: '\u2397 Copy ID' });
    (function (sid) {
      copyIdBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        navigator.clipboard.writeText(sid).then(function () {
          showToast('Copied session ID');
        }).catch(function () {
          var ta = document.createElement('textarea');
          ta.value = sid;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          showToast('Copied session ID');
        });
      });
    })(agent.session_id);
    quickActions.appendChild(copyIdBtn);
  }

  if (quickActions.childNodes.length > 0) {
    children.push(quickActions);
  }

  // Store tooltip data for custom tooltip
  var tipParts = [];
  if (agent.name) tipParts.push('Name: ' + agent.name);
  tipParts.push('ID: ' + agent.id);
  if (agent.session_id) tipParts.push('Session: ' + agent.session_id);
  if (agent.cwd) tipParts.push('Path: ' + agent.cwd);
  if (agent.model) tipParts.push('Model: ' + agent.model);
  tipParts.push('Status: ' + statusClass);
  if (agent.current_tool) tipParts.push('Activity: ' + agent.current_tool);
  if (agent.current_mission_id) tipParts.push('Mission: ' + agent.current_mission_id);

  var row = createEl('div', { className: rowClass, 'data-agent-id': agent.id }, children);
  row.setAttribute('data-tooltip', tipParts.join('\n'));
  return row;
}

// Track collapsed sessions (persisted)
var SESSION_COLLAPSE_KEY = 'switchyard_session_collapsed';
var OLD_SESSION_COLLAPSE_KEY = 'mc_session_collapsed';
var collapsedSessions = {};
try {
  var saved = localStorage.getItem(SESSION_COLLAPSE_KEY) || localStorage.getItem(OLD_SESSION_COLLAPSE_KEY);
  if (saved) collapsedSessions = JSON.parse(saved);
} catch (e) {}

// Subagents start collapsed under a parent; a group with no parent row starts open.
function isSessionCollapsed(sid, hasMain) {
  if (sid in collapsedSessions) return !!collapsedSessions[sid];
  return hasMain;
}

function toggleSessionCollapse(sid, hasMain) {
  collapsedSessions[sid] = !isSessionCollapsed(sid, hasMain);
  try { localStorage.setItem(SESSION_COLLAPSE_KEY, JSON.stringify(collapsedSessions)); } catch (e) {}
  renderAgents();
}

function renderAgents() {
  // Show filtered count vs total
  var activeCount = state.agents.filter(isRecentAgent).length;
  var totalCount = state.agents.length;
  $agentsBadge.textContent = agentFilter === 'all' ? totalCount : activeCount + '/' + totalCount;
  $agentsBadge.title = activeCount + ' active in the last 24 h, ' + totalCount + ' in total';
  clearElement($agentsList);

  if (state.agents.length === 0) {
    $agentsList.appendChild(emptyState('No agents yet', 'Start Claude Code in a project folder and it appears here. Run "switchyard install" once if it does not.'));
    return;
  }

  var tree = buildAgentTree();
  var flatIdx = 0;
  var sessionIds = Object.keys(tree.sessions);
  var visibleCount = 0;

  sessionIds.forEach(function (sid) {
    var group = tree.sessions[sid];
    var main = group.main;
    var subs = group.subs;
    var isCollapsed = isSessionCollapsed(sid, !!main);

    // Filter: skip entire session if no agents match
    var mainMatches = main && matchesAgentFilter(main);
    var matchingSubs = subs.filter(matchesAgentFilter);
    if (!mainMatches && matchingSubs.length === 0) {
      // Still increment flatIdx for hidden agents
      if (main) flatIdx++;
      flatIdx += subs.length;
      return;
    }

    var container = createEl('div', { className: 'agent-group' + (isCollapsed ? ' session-collapsed' : '') });

    // Main agent row (filtered)
    if (main && mainMatches) {
      main._subCount = matchingSubs.length;
      main._sessionCollapsed = isCollapsed;
      container.appendChild(buildAgentRow(main, false, false, flatIdx++));
      visibleCount++;
    } else if (main) {
      flatIdx++;
    }

    // Session label — only when there's no main agent for this group
    if (!main && matchingSubs.length > 0) {
      // Try to get project name from first sub's cwd
      var groupLabel = 'Subagents';
      var firstSub = matchingSubs[0];
      if (firstSub && firstSub.cwd) {
        groupLabel = firstSub.cwd.split('/').filter(Boolean).pop() || groupLabel;
      }
      var subToggle = createEl('div', { className: 'agent-group-label agent-sub-toggle', textContent: (isCollapsed ? '\u25B8 ' : '\u25BE ') + groupLabel + ' \u00B7 ' + matchingSubs.length + ' sub' });
      subToggle.setAttribute('role', 'button');
      subToggle.setAttribute('tabindex', '0');
      subToggle.setAttribute('aria-expanded', String(!isCollapsed));
      subToggle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSessionCollapse(sid, !!main); }
      });
      container.appendChild(subToggle);
    }

    // Toggle click
    (function (capturedSid) {
      container.addEventListener('click', function (e) {
        if (e.target.closest('.agent-sub-toggle')) {
          e.stopPropagation();
          toggleSessionCollapse(capturedSid, !!main);
        }
      });
    })(sid);

    // Subagents (filtered + collapsible)
    if (matchingSubs.length > 0 && !isCollapsed) {
      var subContainer = createEl('div', { className: 'agent-subs' });
      matchingSubs.forEach(function (sub, j) {
        sub._subCount = 0;
        subContainer.appendChild(buildAgentRow(sub, true, j === matchingSubs.length - 1, flatIdx++));
        visibleCount++;
      });
      container.appendChild(subContainer);
    } else {
      flatIdx += matchingSubs.length;
    }
    if (isCollapsed) visibleCount += matchingSubs.length; // counted, just folded away
    // Advance flatIdx past non-matching subs
    flatIdx += subs.length - matchingSubs.length;

    $agentsList.appendChild(container);
  });

  tree.orphans.forEach(function (agent) {
    if (matchesAgentFilter(agent)) {
      agent._subCount = 0;
      $agentsList.appendChild(buildAgentRow(agent, false, true, flatIdx++));
      visibleCount++;
    } else {
      flatIdx++;
    }
  });

  if (visibleCount === 0) {
    $agentsList.appendChild(createEl('div', {
      className: 'empty-state',
      textContent: agentFilter === 'all' ? 'No agents' : 'No agents in the last 24 h'
    }));
    if (agentFilter !== 'all' && totalCount > activeCount) {
      $agentsList.lastChild.appendChild(createEl('div', { className: 'empty-hint', textContent: 'Choose ALL to see ' + (totalCount - activeCount) + ' older' }));
    }
  }
}

// ── Missions panel ────────────────────────────────────────────────────────

var expandedMissionId = null;

function patchMission(missionId, fields) {
  return fetch('/api/missions/' + missionId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
    credentials: 'include',
  }).then(function (res) {
    if (!res.ok) return res.json().then(function (b) { showToast('Error: ' + (b.error || res.status)); });
    return res.json().then(function (updated) {
      upsertMission(updated);
      renderMissions();
      updateHeaderStats();
    });
  }).catch(function () { showToast('Failed to update mission'); });
}

function deleteMission(missionId) {
  return fetch('/api/missions/' + missionId, {
    method: 'DELETE',
    credentials: 'include',
  }).then(function (res) {
    if (res.ok) {
      state.missions = state.missions.filter(function (m) { return m.id !== missionId; });
      expandedMissionId = null;
      renderMissions();
      updateHeaderStats();
      showToast('Mission deleted');
    } else {
      return res.json().then(function (b) { showToast('Error: ' + (b.error || res.status)); });
    }
  }).catch(function () { showToast('Failed to delete mission'); });
}

function buildMissionActions(mission) {
  var status = mission.status || 'queued';
  var actions = createEl('div', { className: 'mission-actions' });

  // Simple checklist: toggle done / reopen + delete
  if (status === 'completed') {
    var reopenBtn = createEl('button', { className: 'mission-action-btn', textContent: '\u21BB REOPEN' });
    reopenBtn.addEventListener('click', function () { patchMission(mission.id, { status: 'queued' }); });
    actions.appendChild(reopenBtn);
  } else {
    var doneBtn = createEl('button', { className: 'mission-action-btn success', textContent: '\u2713 DONE' });
    doneBtn.addEventListener('click', function () { patchMission(mission.id, { status: 'completed' }); });
    actions.appendChild(doneBtn);
  }

  var delBtn = createEl('button', { className: 'mission-action-btn danger', textContent: '\u2715 DELETE' });
  delBtn.addEventListener('click', function () { deleteMission(mission.id); });
  actions.appendChild(delBtn);

  return actions;
}

var showCompletedMissions = false;

function renderMissions() {
  var doneCount = state.missions.filter(function (m) { return !isOpenMission(m); }).length;
  $missionsBadge.textContent = state.missions.length - doneCount;
  $missionsBadge.title = doneCount + ' completed';
  clearElement($missionsList);

  if (state.missions.length === 0) {
    $missionsList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No goals yet — press n to add one' }));
    return;
  }
  if (doneCount === state.missions.length && !showCompletedMissions) {
    $missionsList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No open missions — press n to add one' }));
  }

  state.missions.forEach(function (mission, i) {
    var status = mission.status || 'queued';
    var isDone = status === 'completed';
    if (isDone && !showCompletedMissions) return;
    var focused = (state.activePanel === 1 && state.focusedRow[1] === i);
    var isExpanded = expandedMissionId === mission.id;
    var isLinked = state.selectedAgentId && mission.assigned_agent_id === state.selectedAgentId;
    var rowClass = 'mission-row' + (focused ? ' focused' : '') + (isExpanded ? ' expanded' : '') + (isDone ? ' done' : '') + (isLinked ? ' agent-linked' : '');

    // Simple checkbox-style indicator
    var checkbox = createEl('span', {
      className: 'goal-check' + (isDone ? ' checked' : ''),
      textContent: isDone ? '\u2713' : '\u25CB'  // ✓ or ○
    });
    var titleEl = createEl('span', { className: 'mission-title' + (isDone ? ' strikethrough' : ''), textContent: mission.title });

    var metaText = '';
    if (mission.completed_at && isDone) {
      metaText = timeAgo(mission.completed_at);
    } else if (mission.created_at) {
      metaText = timeAgo(mission.created_at);
    }
    var metaEl = metaText ? createEl('span', { className: 'mission-meta', textContent: metaText }) : null;

    var topRow = createEl('div', { className: 'mission-top' }, [checkbox, titleEl, metaEl].filter(Boolean));
    var children = [topRow];

    // Expanded details
    if (isExpanded) {
      var details = createEl('div', { className: 'mission-expanded' });

      // Description
      if (mission.description) {
        details.appendChild(createEl('div', { className: 'mission-desc', textContent: mission.description }));
      }

      // Agent info
      if (mission.assigned_agent_id) {
        var agent = state.agents.find(function (a) { return a.id === mission.assigned_agent_id; });
        var agentInfo = createEl('div', { className: 'mission-agent-info' });

        var agentName = agent ? agentDisplayName(agent) : mission.assigned_agent_id;
        var agentStatus = agent ? agent.status : 'unknown';
        var dotChar = STATUS_DOTS[agentStatus] || STATUS_DOTS.disconnected;

        agentInfo.appendChild(createEl('span', { className: 'mission-info-label', textContent: 'Agent:' }));
        agentInfo.appendChild(createEl('span', { className: 'agent-dot ' + agentStatus, textContent: dotChar }));
        agentInfo.appendChild(createEl('span', { className: 'mission-info-value', textContent: agentName }));

        if (agent && agent.cwd) {
          agentInfo.appendChild(createEl('br'));
          agentInfo.appendChild(createEl('span', { className: 'mission-info-label', textContent: 'Path:' }));
          agentInfo.appendChild(createEl('span', { className: 'mission-info-value mono', textContent: agent.cwd }));
        }

        if (agent && agent.model) {
          agentInfo.appendChild(createEl('br'));
          agentInfo.appendChild(createEl('span', { className: 'mission-info-label', textContent: 'Model:' }));
          agentInfo.appendChild(createEl('span', { className: 'mission-info-value', textContent: agent.model }));
        }

        if (agent && agent.current_tool) {
          agentInfo.appendChild(createEl('br'));
          agentInfo.appendChild(createEl('span', { className: 'mission-info-label', textContent: 'Doing:' }));
          agentInfo.appendChild(createEl('span', { className: 'mission-info-value', textContent: agent.current_tool }));
        }

        details.appendChild(agentInfo);
      }

      // Timestamps
      var times = createEl('div', { className: 'mission-timestamps' });
      if (mission.started_at) {
        times.appendChild(createEl('span', { textContent: 'Started ' + timeAgo(mission.started_at) }));
      }
      if (mission.completed_at) {
        times.appendChild(createEl('span', { textContent: (isDone ? 'Completed ' : 'Ended ') + timeAgo(mission.completed_at) }));
      }
      if (mission.created_at && !mission.started_at) {
        times.appendChild(createEl('span', { textContent: 'Created ' + timeAgo(mission.created_at) }));
      }
      if (times.childNodes.length > 0) details.appendChild(times);

      // Action buttons
      details.appendChild(buildMissionActions(mission));
      children.push(details);
    }

    var row = createEl('div', { className: rowClass, 'data-mission-id': mission.id }, children);
    $missionsList.appendChild(row);
  });

  if (doneCount > 0) {
    var toggle = createEl('button', {
      className: 'missions-toggle',
      type: 'button',
      textContent: showCompletedMissions ? 'Hide completed' : 'Show ' + doneCount + ' completed',
    });
    toggle.setAttribute('aria-expanded', String(showCompletedMissions));
    toggle.addEventListener('click', function () {
      showCompletedMissions = !showCompletedMissions;
      renderMissions();
    });
    $missionsList.appendChild(toggle);
  }
}

// Click to expand/collapse mission
$missionsList.addEventListener('click', function (e) {
  // Don't toggle if clicking an action button or select
  if (e.target.closest('.mission-action-btn, .mission-agent-select')) return;
  var row = e.target.closest('[data-mission-id]');
  if (!row) return;
  var id = row.getAttribute('data-mission-id');
  expandedMissionId = (expandedMissionId === id) ? null : id;
  renderMissions();
});

// Clear completed + failed missions
var $clearDone = document.getElementById('clear-done-missions');
if ($clearDone) {
  $clearDone.addEventListener('click', function () {
    var done = state.missions.filter(function (m) { return m.status === 'completed' || m.status === 'failed'; });
    if (done.length === 0) { showToast('No completed missions'); return; }
    done.forEach(function (m) { deleteMission(m.id); });
    showToast('Cleared ' + done.length + ' mission' + (done.length !== 1 ? 's' : ''));
  });
}

var $clearAll = document.getElementById('clear-all-missions');
if ($clearAll) {
  $clearAll.addEventListener('click', function () {
    if (state.missions.length === 0) { showToast('No missions'); return; }
    var count = state.missions.length;
    state.missions.slice().forEach(function (m) { deleteMission(m.id); });
    showToast('Cleared all ' + count + ' missions');
  });
}

