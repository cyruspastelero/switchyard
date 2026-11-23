// Login page behaviour. Kept in its own file so the page needs no inline script.
(function() {
  var form = document.getElementById('login-form');
  var input = document.getElementById('code-input');
  var error = document.getElementById('login-error');

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var code = input.value.trim();
    if (code.length !== 6) {
      error.textContent = 'Enter the 6-digit code';
      return;
    }
    error.textContent = '';

    error.textContent = 'Checking the code\u2026';
    error.style.color = 'var(--text-muted)';

    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
      credentials: 'include',
    })
      .then(function(res) {
        error.style.color = '';
        if (res.ok) {
          error.textContent = '';
          // Small delay to let the cookie settle
          setTimeout(function() { window.location.href = '/'; }, 200);
        } else if (res.status === 429) {
          error.textContent = 'Too many attempts. Wait 15 minutes.';
          input.value = '';
        } else if (res.status === 401) {
          return res.json().then(function(body) {
            error.textContent = 'Wrong code. Copy the current one from the Switchyard menu and try again.';
            input.value = '';
            input.focus();
          });
        } else {
          error.textContent = 'Server error (' + res.status + '). Try again.';
          input.value = '';
          input.focus();
        }
      })
      .catch(function(err) {
        error.style.color = '';
        error.textContent = 'Cannot reach the server. Start it with: switchyard install-service';
      });
  });

  // Auto-submit when 6 digits entered
  input.addEventListener('input', function() {
    input.value = input.value.replace(/\D/g, '');
    if (input.value.length === 6) {
      form.dispatchEvent(new Event('submit'));
    }
  });

  // Already signed in (for example after following a link from another site, which never carries
  // the session cookie): go straight to the dashboard.
  fetch('/api/dashboard', { credentials: 'same-origin' }).then(function(res) {
    if (res.ok) window.location.replace('/');
  }).catch(function() { /* server not reachable: stay on the login page */ });
})();
