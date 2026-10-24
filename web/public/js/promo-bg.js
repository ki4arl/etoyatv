(function () {
  'use strict';

  var ALL_VARIANTS = [
    'night', 'ueit', 'day',
    'motion-1', 'motion-2', 'motion-3', 'motion-4', 'motion-5'
  ];
  var ROTATE_MIN_MS = 42000;
  var ROTATE_JITTER_MS = 18000;

  function shuffle(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function nextInChain(chain, current) {
    var i = chain.indexOf(current);
    if (i < 0) return chain[0];
    return chain[(i + 1) % chain.length];
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function prepClip(clip) {
    clip.muted = true;
    clip.defaultMuted = true;
    clip.autoplay = true;
    clip.loop = true;
    clip.setAttribute('muted', '');
    clip.setAttribute('autoplay', '');
    clip.setAttribute('loop', '');
    clip.setAttribute('playsinline', '');
    if ('playsInline' in clip) clip.playsInline = true;
  }

  function pickUrl(clip) {
    var webm = clip.getAttribute('data-webm') || '';
    var mp4 = clip.getAttribute('data-mp4') || '';
    if (webm && clip.canPlayType && clip.canPlayType('video/webm') !== '') return webm;
    if (mp4) return mp4;
    return webm || mp4;
  }

  /** One active src at a time — no 8× parallel CDN fetches. */
  function ensureSources(clip) {
    if (!clip) return false;
    var url = pickUrl(clip);
    if (!url) return false;
    if (clip.getAttribute('data-sources-ready') === '1' && clip.currentSrc) return true;

    while (clip.firstChild) clip.removeChild(clip.firstChild);
    clip.src = url;
    clip.setAttribute('data-sources-ready', '1');
    clip.preload = 'auto';
    return true;
  }

  function unloadClip(clip) {
    if (!clip) return;
    try { clip.pause(); } catch (e) {}
    clip.removeAttribute('autoplay');
    clip.autoplay = false;
    if (clip.getAttribute('data-sources-ready') !== '1') return;
    clip.removeAttribute('src');
    while (clip.firstChild) clip.removeChild(clip.firstChild);
    clip.removeAttribute('data-sources-ready');
    clip.preload = 'none';
    try { clip.load(); } catch (e2) {}
  }

  function playClip(clip) {
    if (!clip) return;
    prepClip(clip);
    if (!ensureSources(clip)) return;

    var started = false;
    function go() {
      if (started) return;
      started = true;
      prepClip(clip);
      var attempt = clip.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(function () {
          // Retry once after a fresh load (autoplay / decode races)
          try { clip.load(); } catch (e) {}
          clip.addEventListener('loadeddata', function retry() {
            prepClip(clip);
            clip.play().catch(function () {});
          }, { once: true });
        });
      }
    }

    if (clip.readyState >= 2) {
      go();
      return;
    }

    clip.addEventListener('loadeddata', go, { once: true });
    clip.addEventListener('canplay', go, { once: true });
    try { clip.load(); } catch (e3) {}
  }

  function setActive(shell, id) {
    shell.setAttribute('data-promo-bg', id);
    shell.querySelectorAll('.promo-bg__clip').forEach(function (clip) {
      var on = clip.getAttribute('data-promo-bg') === id;
      clip.classList.toggle('is-active', on);
      if (on) playClip(clip);
      else unloadClip(clip);
    });
  }

  function prefetchNext(shell, id) {
    var chain = shell._promoChain || ALL_VARIANTS;
    var nextId = nextInChain(chain, id);
    var next = shell.querySelector('.promo-bg__clip[data-promo-bg="' + nextId + '"]');
    if (!next || next.getAttribute('data-sources-ready') === '1') return;
    ensureSources(next);
    next.preload = 'metadata';
    try { next.load(); } catch (e) {}
  }

  function schedule(shell) {
    if (reducedMotion()) return;
    clearTimeout(shell._promoTimer);
    clearTimeout(shell._promoPrefetch);
    var delay = ROTATE_MIN_MS + Math.floor(Math.random() * ROTATE_JITTER_MS);
    var prefetchIn = Math.max(2000, delay - 8000);
    shell._promoPrefetch = setTimeout(function () {
      prefetchNext(shell, shell.getAttribute('data-promo-bg'));
    }, prefetchIn);
    shell._promoTimer = setTimeout(function () {
      var chain = shell._promoChain || ALL_VARIANTS;
      setActive(shell, nextInChain(chain, shell.getAttribute('data-promo-bg')));
      schedule(shell);
    }, delay);
  }

  function init(shell) {
    if (!shell || shell.getAttribute('data-promo-bg-ready') === '1') return;
    if (reducedMotion()) {
      shell.setAttribute('data-promo-bg-ready', '1');
      return;
    }

    shell._promoChain = shuffle(ALL_VARIANTS);
    shell.querySelectorAll('.promo-bg__clip').forEach(prepClip);

    // Activate first, then mark ready (CSS hides non-active only after ready)
    setActive(shell, shell._promoChain[0]);
    shell.setAttribute('data-promo-bg-ready', '1');
    schedule(shell);
  }

  function boot() {
    document.querySelectorAll('.promo-shell').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
