/* Fills legal pages from js/legal-config.js and builds the table of contents. */
(function () {
  var L = window.GC_LEGAL || {};
  var mail = L.contactEmail || '', smail = L.securityEmail || mail;
  document.querySelectorAll('[data-legal]').forEach(function (el) {
    var k = el.getAttribute('data-legal'), v = L[k] || '';
    if (k === 'contactEmail' || k === 'securityEmail') {
      v = (k === 'securityEmail' ? smail : mail);
      if (v) { el.innerHTML = '<a href="mailto:' + v.replace(/[^A-Za-z0-9@._+-]/g, '') + '"></a>'; el.firstChild.textContent = v; }
      else el.textContent = 'the contact details shown on our website';
    } else el.textContent = v;
  });
  var box = document.getElementById('lgSetup');
  if (box && !mail) box.style.display = 'block';
  var toc = document.getElementById('lgToc');
  if (toc) {
    var hs = document.querySelectorAll('.lg-main h2'), html = '<b>On this page</b>';
    hs.forEach(function (h, i) { if (!h.id) h.id = 's' + (i + 1); html += '<a href="#' + h.id + '"></a>'; });
    toc.innerHTML = html;
    toc.querySelectorAll('a').forEach(function (a, i) { a.textContent = hs[i].textContent; });
  }
  var y = document.getElementById('lgYear'); if (y) y.textContent = new Date().getFullYear();
})();
