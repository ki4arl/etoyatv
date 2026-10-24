(function (window, document) {
  function ajaxifyList(opts) {
    var form = document.querySelector(opts.form);
    var box = document.getElementById(opts.boxId);
    if (!form || !box) return;
    var action = form.getAttribute('action') || window.location.pathname;

    function currentView() {
      return box.querySelector('.channels_grid, .records_grid') ? 'grid' : 'list';
    }

    function applyView(view) {
      var el = box.querySelector('.channels_list, .channels_grid, .records_list, .records_grid');
      if (!el || !opts.preserveView) return;
      var records = el.classList.contains('records_list') || el.classList.contains('records_grid');
      var listCls = records ? 'records_list' : 'channels_list';
      var gridCls = records ? 'records_grid' : 'channels_grid';
      el.classList.toggle(gridCls, view === 'grid');
      el.classList.toggle(listCls, view === 'list');
    }

    function withAjax(url) {
      var u = new URL(url, window.location.origin);
      u.searchParams.set('ajax', '1');
      return u.pathname + u.search;
    }

    function withoutAjax(url) {
      var u = new URL(url, window.location.origin);
      u.searchParams.delete('ajax');
      return u.pathname + u.search;
    }

    function buildUrl(sort, live) {
      var u = new URL(action, window.location.origin);
      var q = form.querySelector('input[name="q"]');
      if (sort && sort !== 'new') u.searchParams.set('sort', sort);
      if (live) u.searchParams.set('live', '1');
      if (q && q.value) u.searchParams.set('q', q.value);
      return u.pathname + u.search;
    }

    function currentSort() {
      var active = form.querySelector('a[data-sort].active');
      return (active && active.getAttribute('data-sort')) || 'new';
    }

    function syncForm(url) {
      var u = new URL(url, window.location.origin);
      var sort = u.searchParams.get('sort') || 'new';
      var live = u.searchParams.get('live') === '1';
      var links = form.querySelectorAll('a[data-sort]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var s = a.getAttribute('data-sort');
        a.classList.toggle('active', s === sort);
        a.setAttribute('href', buildUrl(s, live));
      }
      var liveBox = form.querySelector('[name="live"]');
      if (liveBox) liveBox.checked = live;
    }

    var seq = 0;
    function load(url, push) {
      var view = currentView();
      var id = ++seq;
      box.classList.add('list-filters-loading');
      fetch(withAjax(url), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (r) { return r.text(); })
        .then(function (html) {
          if (id !== seq) return;
          var parsed = new DOMParser().parseFromString(html, 'text/html');
          var inner = parsed.getElementById(opts.boxId);
          box.innerHTML = inner ? inner.innerHTML : parsed.body.innerHTML;
          applyView(view);
          box.classList.remove('list-filters-loading');
          var seeded = box.querySelector('[data-list-href]');
          var next = (seeded && seeded.getAttribute('data-list-href')) || withoutAjax(url);
          syncForm(next);
          if (push !== false && window.location.pathname + window.location.search !== next) {
            history.pushState({ listAjax: true }, '', next);
          }
        })
        .catch(function () {
          if (id !== seq) return;
          window.location.href = withoutAjax(url);
        });
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); });

    form.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-sort]');
      if (!a) return;
      e.preventDefault();
      load(a.getAttribute('href'));
    });

    form.addEventListener('change', function (e) {
      if (!e.target.matches('[name="live"]')) return;
      load(buildUrl(currentSort(), e.target.checked));
    });

    box.addEventListener('click', function (e) {
      var a = e.target.closest('.pager a');
      if (!a) return;
      e.preventDefault();
      load(a.getAttribute('href'));
    });

    window.addEventListener('popstate', function () {
      load(window.location.pathname + window.location.search, false);
    });
  }

  window.ajaxifyList = ajaxifyList;
})(window, document);
