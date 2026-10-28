// DEMO-ONLY dashboard. No framework, no inline script, no eval, no HTML strings: every value is placed with textContent,
// so a hostile string in an evidence record cannot become markup.
(function () {
  'use strict';
  var $ = function (id) {
    return document.getElementById(id);
  };
  var feed = $('feed');
  var MAX_ROWS = 300;
  var latestSeq = -1;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function short(hash) {
    return typeof hash === 'string' ? hash.slice(0, 10) : '';
  }
  function chip(decision) {
    var labels = {
      allow: 'ALLOW',
      deny: 'DENY',
      require_approval: 'NEEDS APPROVAL',
      approved: 'APPROVED',
      denied: 'DENIED',
      timeout: 'TIMED OUT',
    };
    return el(
      'span',
      'chip chip-' +
        (decision === 'approved' ? 'allow' : decision === 'denied' || decision === 'timeout' ? 'deny' : decision),
      labels[decision] || String(decision),
    );
  }
  function countsText(counts) {
    if (!counts) return 'none';
    var parts = [];
    Object.keys(counts).forEach(function (k) {
      if (counts[k] > 0) parts.push(counts[k] + ' ' + k);
    });
    return parts.length ? parts.join(', ') : 'none';
  }

  // ---- evidence chain badge ----------------------------------------------------------------------------------------
  function setBadge(state) {
    var badge = $('badge');
    var label = $('badge-label');
    var detail = $('badge-detail');
    if (!state || !state.result) return;
    var r = state.result;
    var a = state.anchor || {};
    if (r.ok) {
      badge.className = 'badge badge-ok';
      label.textContent = 'Evidence chain verified (' + r.length + ' records)';
      detail.textContent = a.present
        ? 'Matches the external anchor (length ' + a.length + ', head ' + short(a.head_hash) + ').'
        : 'No external anchor yet.';
    } else if (r.reason === 'anchor-mismatch') {
      badge.className = 'badge badge-bad';
      label.textContent = 'Chain REWRITTEN: does not match the external anchor';
      detail.textContent =
        'The records are internally consistent, but the anchored head is gone (first difference at record ' +
        r.index +
        ').';
    } else if (r.reason === 'truncated') {
      badge.className = 'badge badge-bad';
      label.textContent = 'Chain TRUNCATED: records are missing from the end';
      detail.textContent = r.detail;
    } else {
      badge.className = 'badge badge-bad';
      label.textContent = 'Evidence chain FAILED at record ' + r.index + ' (' + r.reason + ')';
      detail.textContent = r.detail;
    }
    $('info-anchor').textContent = a.present ? 'length ' + a.length + ', head ' + short(a.head_hash) : 'none yet';
  }

  // ---- feed ----------------------------------------------------------------------------------------------------------
  function describe(rec) {
    var d = rec.data || {};
    var line = el('div');
    var detail = '';
    switch (rec.type) {
      case 'policy.loaded':
        line.appendChild(
          el(
            'span',
            null,
            'Policy loaded: ' +
              (d.policy_name || 'unnamed') +
              ', ' +
              d.rule_count +
              ' rules, hash ' +
              short(d.policy_hash),
          ),
        );
        break;
      case 'request.received':
        line.appendChild(
          el(
            'span',
            null,
            'Request ' +
              short(d.request_id) +
              ' received. Redacted before the model: ' +
              countsText(d.redaction_counts),
          ),
        );
        break;
      case 'model.response':
        line.appendChild(
          el(
            'span',
            null,
            'Model answered (' +
              d.mode +
              '): ' +
              d.tool_call_count +
              ' tool request(s), ' +
              d.invalid_calls +
              ' malformed',
          ),
        );
        break;
      case 'tool_call.decision':
        line.appendChild(el('span', null, 'Tool ' + (d.tool || '(unreadable)') + ' '));
        line.appendChild(chip(d.decision));
        detail = d.rule_id
          ? 'rule ' + d.rule_id + ', source ' + d.source
          : 'reason: ' + d.reason + (d.detail ? ' (' + d.detail + ')' : '');
        break;
      case 'approval.requested':
        line.appendChild(el('span', null, 'Approval requested for ' + d.tool + ' '));
        line.appendChild(chip('require_approval'));
        detail = 'rule ' + d.rule_id + ', source ' + d.source;
        break;
      case 'approval.resolved':
        line.appendChild(el('span', null, 'Approval for ' + d.tool + ': '));
        line.appendChild(chip(d.outcome));
        detail = 'decided by ' + rec.actor + ' (' + d.decided_by + ')';
        break;
      case 'request.completed':
        line.appendChild(
          el(
            'span',
            null,
            'Request ' +
              short(d.request_id) +
              ' completed: ' +
              d.allowed +
              ' allowed, ' +
              d.denied +
              ' denied, ' +
              d.approvals +
              ' approval(s)',
          ),
        );
        break;
      case 'model.error':
        line.appendChild(el('span', null, 'Model unavailable (' + d.kind + '). Nothing was approved.'));
        break;
      default:
        line.appendChild(el('span', null, rec.type + ' by ' + rec.actor));
    }
    var wrap = el('div');
    wrap.appendChild(line);
    wrap.appendChild(el('div', 'line2', (detail ? detail + ' · ' : '') + rec.ts + ' · hash ' + short(rec.record_hash)));
    return wrap;
  }
  function addRecord(rec) {
    if (typeof rec.seq !== 'number' || rec.seq <= latestSeq) return;
    latestSeq = rec.seq;
    var li = el('li');
    li.appendChild(el('span', 'seq', '#' + rec.seq));
    li.appendChild(describe(rec));
    feed.insertBefore(li, feed.firstChild);
    while (feed.children.length > MAX_ROWS) feed.removeChild(feed.lastChild);
    $('info-count').textContent = String(rec.seq + 1);
  }

  // ---- approval queue ------------------------------------------------------------------------------------------------
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-demo-action': '1' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (json) {
        return { status: r.status, json: json };
      });
    });
  }
  function renderQueue(pending) {
    var list = $('queue');
    list.replaceChildren();
    $('queue-empty').hidden = pending.length > 0;
    pending.forEach(function (p) {
      var li = el('li');
      li.appendChild(el('strong', null, p.tool + ' '));
      li.appendChild(chip('require_approval'));
      li.appendChild(el('div', 'meta', 'rule ' + p.rule_id + ', source ' + p.source + ', requested ' + p.requested_at));
      li.appendChild(el('pre', null, JSON.stringify(p.arguments, null, 2)));
      var row = el('div', 'buttons');
      [
        ['approve', 'Approve'],
        ['deny', 'Deny'],
      ].forEach(function (pair) {
        var b = el('button', pair[0], pair[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          b.disabled = true;
          post('/demo/approvals/' + p.id, {
            decision: pair[0],
            actor: $('actor').value.trim() || 'demo-reviewer',
          }).then(function (res) {
            if (res.status !== 200) {
              $('tamper-note').textContent =
                'That approval could not be recorded: ' + (res.json.error ? res.json.error.message : res.status);
              b.disabled = false;
            }
          });
        });
        row.appendChild(b);
      });
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  // ---- tamper and verify ---------------------------------------------------------------------------------------------
  function note(text) {
    $('tamper-note').textContent = text;
  }
  function tamper(action) {
    var seq = Number($('seq').value);
    note('Working...');
    post('/demo/tamper', { action: action, seq: seq }).then(function (res) {
      if (res.status !== 200) {
        note('Refused: ' + (res.json.error ? res.json.error.message : res.status));
        return;
      }
      setBadge(res.json.verify);
      note('Done. See the badge above for what verification now says.');
    });
  }
  $('btn-edit').addEventListener('click', function () {
    tamper('edit');
  });
  $('btn-rewrite').addEventListener('click', function () {
    tamper('rewrite');
  });
  $('btn-delete').addEventListener('click', function () {
    tamper('delete');
  });
  $('btn-verify').addEventListener('click', function () {
    fetch('/demo/verify')
      .then(function (r) {
        return r.json();
      })
      .then(function (s) {
        setBadge(s);
        note('Verified just now.');
      });
  });
  $('btn-reset').addEventListener('click', function () {
    post('/demo/reset', {}).then(function (res) {
      if (res.status !== 200) {
        note('Refused: ' + (res.json.error ? res.json.error.message : res.status));
        return;
      }
      feed.replaceChildren();
      latestSeq = -1;
      connect(); // reconnecting replays the recent records, including the fresh first one
      note('The demo was reset to a clean chain.');
    });
  });

  // ---- live stream ---------------------------------------------------------------------------------------------------
  function applyState(s) {
    $('info-model').textContent = s.model;
    $('info-mode').textContent = s.mode;
    $('info-policy').textContent =
      (s.policy.name || 'unnamed') + ' (' + s.policy.rule_count + ' rules, ' + short(s.policy.hash) + ')';
    setBadge(s.verify);
    renderQueue(s.approvals || []);
    if (!s.tamper_enabled) document.querySelector('.tamper').hidden = true;
  }
  var source = null;
  function connect() {
    if (source) source.close();
    source = new EventSource('/demo/events');
    source.addEventListener('state', function (e) {
      applyState(JSON.parse(e.data));
    });
    source.addEventListener('record', function (e) {
      addRecord(JSON.parse(e.data));
    });
    source.addEventListener('approvals', function (e) {
      renderQueue(JSON.parse(e.data).pending);
    });
    source.addEventListener('verify', function (e) {
      setBadge(JSON.parse(e.data));
    });
    source.onerror = function () {
      $('badge-detail').textContent = 'Connection to the demo server was lost; retrying...';
    };
  }
  connect();
})();
