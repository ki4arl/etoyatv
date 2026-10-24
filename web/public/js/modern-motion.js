/**
 * Плавные переключения для темы «Эфир».
 * JS по-прежнему управляет display, но show/hide идут через короткую анимацию.
 */
(function (global) {
  'use strict';

  var DUR = 180;
  var DUR_FAST = 120;

  function reduced() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function panelDisplay(el, fallback) {
    if (el && el.dataset && el.dataset.modernDisplay) return el.dataset.modernDisplay;
    return fallback || 'block';
  }

  function isOpen(el) {
    return el && el.style.display !== 'none' && el.style.display !== '';
  }

  function show(el, opts) {
    if (!el) return Promise.resolve();
    var display = (opts && opts.display) || panelDisplay(el, 'block');
    if (reduced()) {
      el.style.display = display;
      el.classList.add('modern-panel-open');
      el.classList.remove('modern-panel-closing');
      el.style.opacity = '';
      el.style.transform = '';
      return Promise.resolve();
    }
    if (isOpen(el) && el.classList.contains('modern-panel-open')) return Promise.resolve();
    el.style.display = display;
    el.classList.remove('modern-panel-closing');
    el.classList.add('modern-panel-open');
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        el.removeEventListener('animationend', finish);
        resolve();
      }
      el.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, DUR + 40);
    });
  }

  function hide(el) {
    if (!el || el.style.display === 'none') return Promise.resolve();
    if (reduced()) {
      el.style.display = 'none';
      el.classList.remove('modern-panel-open', 'modern-panel-closing');
      return Promise.resolve();
    }
    el.classList.add('modern-panel-closing');
    el.classList.remove('modern-panel-open');
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        el.style.display = 'none';
        el.classList.remove('modern-panel-closing');
        el.removeEventListener('animationend', finish);
        resolve();
      }
      el.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, DUR_FAST + 40);
    });
  }

  function toggle(el, force, opts) {
    if (!el) return Promise.resolve();
    var open = typeof force === 'boolean' ? force : !isOpen(el);
    return open ? show(el, opts) : hide(el);
  }

  function hideInstant(el) {
    if (!el) return;
    el.style.display = 'none';
    el.classList.remove('modern-panel-open', 'modern-panel-closing');
  }

  function switchTab(blocks, target, activeClass) {
    activeClass = activeClass || 'active';
    if (!target) return;
    var current = null;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].classList.contains(activeClass)) current = blocks[i];
    }
    if (current === target) return;

    blocks.forEach(function (b) {
      b.classList.toggle(activeClass, b === target);
    });

    if (reduced() || !current) return;

    current.classList.add('is-tab-leaving');
    target.classList.add('is-tab-entering');
    setTimeout(function () {
      current.classList.remove('is-tab-leaving');
      target.classList.remove('is-tab-entering');
    }, DUR);
  }

  global.ModernMotion = {
    reduced: reduced,
    show: show,
    hide: hide,
    toggle: toggle,
    hideInstant: hideInstant,
    switchTab: switchTab
  };
})(window);
