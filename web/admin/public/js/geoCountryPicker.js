/**
 * Searchable multi-select for ISO countries (Russian labels).
 * Usage: GeoCountryPicker.mount(rootEl, { name, countries, selected, placeholder })
 */
(function (global) {
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .trim();
  }

  function mount(root, opts) {
    if (!root) return null;
    const name = opts.name || 'geo_countries';
    const countries = Array.isArray(opts.countries) ? opts.countries : [];
    const selected = new Set(
      (opts.selected || []).map(function (c) {
        return String(c).toUpperCase();
      })
    );
    const placeholder = opts.placeholder || 'Начните вводить страну (напр. Ро, Рум)…';

    root.classList.add('geo-picker');
    root.innerHTML =
      '<div class="geo-picker-chips"></div>' +
      '<div class="geo-picker-input-wrap">' +
      '<input type="text" class="geo-picker-search form-control" autocomplete="off" placeholder="' +
      placeholder.replace(/"/g, '&quot;') +
      '">' +
      '<div class="geo-picker-dropdown" hidden></div>' +
      '</div>' +
      '<div class="geo-picker-hidden"></div>';

    const chipsEl = root.querySelector('.geo-picker-chips');
    const searchEl = root.querySelector('.geo-picker-search');
    const dropEl = root.querySelector('.geo-picker-dropdown');
    const hiddenEl = root.querySelector('.geo-picker-hidden');

    function byCode(code) {
      for (let i = 0; i < countries.length; i++) {
        if (countries[i].code === code) return countries[i];
      }
      return { code: code, name: code };
    }

    function syncHidden() {
      hiddenEl.innerHTML = '';
      selected.forEach(function (code) {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = name;
        inp.value = code;
        hiddenEl.appendChild(inp);
      });
    }

    function renderChips() {
      chipsEl.innerHTML = '';
      Array.from(selected)
        .sort(function (a, b) {
          return byCode(a).name.localeCompare(byCode(b).name, 'ru');
        })
        .forEach(function (code) {
          const chip = document.createElement('span');
          chip.className = 'geo-picker-chip';
          chip.innerHTML =
            '<span class="geo-picker-chip-label"></span>' +
            '<button type="button" class="geo-picker-chip-x" aria-label="Убрать">&times;</button>';
          chip.querySelector('.geo-picker-chip-label').textContent = byCode(code).name;
          chip.querySelector('.geo-picker-chip-x').addEventListener('click', function () {
            selected.delete(code);
            renderChips();
            syncHidden();
            renderDropdown(searchEl.value);
          });
          chipsEl.appendChild(chip);
        });
      syncHidden();
    }

    function filterList(q) {
      const nq = norm(q);
      if (!nq) return countries.filter(function (c) { return !selected.has(c.code); }).slice(0, 12);
      return countries
        .filter(function (c) {
          if (selected.has(c.code)) return false;
          return (
            norm(c.name).indexOf(nq) === 0 ||
            norm(c.name).indexOf(nq) >= 0 ||
            norm(c.code).indexOf(nq) === 0
          );
        })
        .sort(function (a, b) {
          const an = norm(a.name).indexOf(nq) === 0 ? 0 : 1;
          const bn = norm(b.name).indexOf(nq) === 0 ? 0 : 1;
          if (an !== bn) return an - bn;
          return a.name.localeCompare(b.name, 'ru');
        })
        .slice(0, 12);
    }

    function renderDropdown(q) {
      const list = filterList(q);
      if (!list.length) {
        dropEl.hidden = true;
        dropEl.innerHTML = '';
        return;
      }
      dropEl.innerHTML = '';
      list.forEach(function (c) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'geo-picker-option';
        btn.innerHTML = '<span class="geo-picker-opt-name"></span><span class="geo-picker-opt-code"></span>';
        btn.querySelector('.geo-picker-opt-name').textContent = c.name;
        btn.querySelector('.geo-picker-opt-code').textContent = c.code;
        btn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          selected.add(c.code);
          searchEl.value = '';
          renderChips();
          renderDropdown('');
          searchEl.focus();
        });
        dropEl.appendChild(btn);
      });
      dropEl.hidden = false;
    }

    searchEl.addEventListener('input', function () {
      renderDropdown(searchEl.value);
    });
    searchEl.addEventListener('focus', function () {
      renderDropdown(searchEl.value);
    });
    searchEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        dropEl.hidden = true;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const first = dropEl.querySelector('.geo-picker-option');
        if (first) first.dispatchEvent(new MouseEvent('mousedown'));
      } else if (e.key === 'Backspace' && !searchEl.value && selected.size) {
        const arr = Array.from(selected);
        selected.delete(arr[arr.length - 1]);
        renderChips();
        renderDropdown('');
      }
    });
    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) dropEl.hidden = true;
    });

    renderChips();
    return {
      getSelected: function () {
        return Array.from(selected);
      },
      setSelected: function (codes) {
        selected.clear();
        (codes || []).forEach(function (c) {
          selected.add(String(c).toUpperCase());
        });
        renderChips();
      }
    };
  }

  global.GeoCountryPicker = { mount: mount };
})(typeof window !== 'undefined' ? window : global);
