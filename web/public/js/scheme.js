(function () {
  var KEY = 'etoyatv_scheme';

  function current() {
    return document.documentElement.getAttribute('data-scheme') === 'light' ? 'light' : 'dark';
  }

  function syncButtons(scheme) {
    var pressed = scheme === 'light';
    var label = pressed ? 'Тёмная тема' : 'Светлая тема';
    var buttons = document.querySelectorAll('[data-scheme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', pressed ? 'true' : 'false');
      buttons[i].setAttribute('aria-label', label);
      buttons[i].title = label;
    }
  }

  function apply(scheme) {
    if (scheme !== 'light' && scheme !== 'dark') return;
    document.documentElement.setAttribute('data-scheme', scheme);
    if (document.body) document.body.setAttribute('data-scheme', scheme);
    try { localStorage.setItem(KEY, scheme); } catch (e) {}
    syncButtons(scheme);
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (window.csrfToken) headers['X-CSRF-Token'] = window.csrfToken;
      fetch('/api/set-scheme', {
        method: 'POST',
        headers: headers,
        credentials: 'same-origin',
        body: JSON.stringify({ scheme: scheme })
      });
    } catch (e) {}
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-scheme-toggle]');
    if (!btn) return;
    e.preventDefault();
    apply(current() === 'light' ? 'dark' : 'light');
  });

  if (document.body) document.body.setAttribute('data-scheme', current());
  syncButtons(current());
})();
