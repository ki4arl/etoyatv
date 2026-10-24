(function () {
  'use strict';

  var COOKIE = 'etoyatv_dfp';
  var MAX_AGE_DAYS = 180;

  function setCookie(name, value, days) {
    var maxAge = days * 24 * 60 * 60;
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; path=/; max-age=' + maxAge + '; SameSite=Lax';
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function canvasFp() {
    try {
      var c = document.createElement('canvas');
      c.width = 200;
      c.height = 50;
      var ctx = c.getContext('2d');
      if (!ctx) return 'no-canvas';
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 120, 50);
      ctx.fillStyle = '#069';
      ctx.fillText('etoyatv-fp', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('etoyatv-fp', 4, 17);
      return c.toDataURL().slice(-64);
    } catch (e) {
      return 'canvas-err';
    }
  }

  function webglFp() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return 'no-webgl';
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      var renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return String(vendor) + '|' + String(renderer);
    } catch (e) {
      return 'webgl-err';
    }
  }

  function hashString(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // unsigned 32-bit → hex-ish stable token
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function collectRaw() {
    var parts = [
      navigator.userAgent || '',
      navigator.language || '',
      (navigator.languages || []).join(','),
      String(screen.width) + 'x' + String(screen.height) + 'x' + String(screen.colorDepth || ''),
      String(window.devicePixelRatio || 1),
      String(new Date().getTimezoneOffset()),
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      String(navigator.hardwareConcurrency || 0),
      String(navigator.maxTouchPoints || 0),
      canvasFp(),
      webglFp()
    ];
    var joined = parts.join('||');
    // Two hashes + length keep collisions low without crypto.subtle dependency
    return hashString(joined) + hashString(joined.split('').reverse().join('')) + String(joined.length);
  }

  function attachToForms(fp) {
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      var existing = form.querySelector('input[name="device_fingerprint"]');
      if (existing) {
        existing.value = fp;
        continue;
      }
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'device_fingerprint';
      input.value = fp;
      form.appendChild(input);
    }
  }

  function init() {
    var cached = getCookie(COOKIE);
    var fp = cached && /^[a-zA-Z0-9_-]+$/.test(cached) ? cached : collectRaw();
    if (!cached || cached !== fp) {
      setCookie(COOKIE, fp, MAX_AGE_DAYS);
    }
    window.__etoyatvDeviceFp = fp;
    attachToForms(fp);

    // Re-attach for dynamically added forms
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () { attachToForms(fp); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
