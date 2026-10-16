// Crew site. Tabs and copy buttons. No frameworks, no external requests.

(function () {
  'use strict';

  // Tabs
  var tablists = document.querySelectorAll('.tabs');
  tablists.forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) {
          var panel = document.getElementById(t.getAttribute('aria-controls'));
          var selected = t === tab;
          t.setAttribute('aria-selected', selected ? 'true' : 'false');
          t.tabIndex = selected ? 0 : -1;
          if (panel) panel.hidden = !selected;
        });
      });
      tab.addEventListener('keydown', function (e) {
        var idx = tabs.indexOf(tab);
        var next = e.key === 'ArrowRight' ? idx + 1 : e.key === 'ArrowLeft' ? idx - 1 : -1;
        if (next < 0 || next >= tabs.length) return;
        e.preventDefault();
        tabs[next].focus();
        tabs[next].click();
      });
    });
  });

  // Copy buttons
  document.querySelectorAll('button[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var source = document.querySelector(btn.getAttribute('data-copy'));
      if (!source) return;
      var text = source.textContent.replace(/^\s*\$\s*/, '').trim();
      var done = function () {
        var old = btn.textContent;
        btn.textContent = 'Copied';
        window.setTimeout(function () { btn.textContent = old; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); } catch (err) { /* no clipboard, no toast */ }
        document.body.removeChild(area);
        done();
      }
    });
  });
})();
