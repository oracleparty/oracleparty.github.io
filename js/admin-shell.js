// ============================================
// Oracle Party — the admin page's desktop shell
//
// A CLASSIC SCRIPT WITH NO IMPORTS, deliberately, and the reason is the whole
// point of the file. Every other module here pulls the Supabase client from
// esm.sh; the layout sweep and the screenshot tool cannot resolve that, so
// js/admin.js never runs under them and the mock has to build the page by hand.
// A mock that rebuilds a layout is a mock that drifts away from it — this
// project has shipped that fault three times and CLAUDE.md records each one.
//
// So the transform lives here, imports nothing, and is loaded as a plain script
// that always executes. js/admin.js calls it and so does scripts/mock-states.js.
// One implementation, so the preview cannot disagree with the page.
//
// WHY A SHELL AT ALL. This page is a workbench, not a screen you glance at: ten
// sections, ~4,859 questions and about 130 title slots to type words into. The
// accordion is the right answer at 375px and the wrong one on a computer, and
// the owner asked for the computer.
//
// IT REPARENTS RATHER THAN DUPLICATING. Every lookup in js/admin.js finds a
// panel by `data-panel` or by `id`, never by position, so moving the heads into
// a nav and the bodies into a work area changes where things are drawn and
// nothing about how they behave. Two copies of the head markup would mean two
// count chips to keep in step, which is the same fault one level along.
// ============================================
(function () {
  var DESKTOP_MIN_WIDTH = 900;

  // The order the owner ranked them in, which is not the order they were built
  // in. Title Words first while ~86 of them are unwritten: that is the job this
  // rebuild exists to unblock. Anything this list does not name keeps its
  // document order AFTER these, so adding a panel later cannot make it vanish
  // from the nav — a section that silently stops being reachable is worse than
  // one in the wrong place.
  var NAV_ORDER = [
    'titlewords', 'questions', 'flagged', 'hosts', 'health',
    'games', 'chat', 'errors', 'announcement', 'flags',
  ];

  function isDesktop() {
    return window.matchMedia('(min-width: ' + DESKTOP_MIN_WIDTH + 'px)').matches;
  }

  /**
   * Turn the accordion into a sidebar and a work area.
   *
   * Returns the panel key that should be open on arrival, or null when nothing
   * was done — below the breakpoint, or already built. The CALLER opens it,
   * because opening a panel means fetching its contents and this file knows
   * nothing about the database.
   */
  function buildAdminShell() {
    if (!isDesktop()) return null;
    var panels = document.querySelector('.admin-panels');
    if (!panels || panels.dataset.shell === 'desktop') return null;

    var sections = Array.prototype.slice.call(panels.querySelectorAll('.admin-panel'));
    if (!sections.length) return null;

    var nav = document.createElement('nav');
    nav.className = 'admin-nav';
    nav.setAttribute('aria-label', 'Admin sections');
    var work = document.createElement('div');
    work.className = 'admin-work';

    var keyOf = function (sec) {
      var head = sec.querySelector('.admin-panel__head');
      return head ? head.dataset.panel : null;
    };
    var byKey = {};
    sections.forEach(function (sec) {
      var k = keyOf(sec);
      if (k) byKey[k] = sec;
    });

    var ordered = [];
    NAV_ORDER.forEach(function (k) { if (byKey[k]) ordered.push(byKey[k]); });
    sections.forEach(function (sec) {
      if (NAV_ORDER.indexOf(keyOf(sec)) === -1) ordered.push(sec);
    });

    ordered.forEach(function (sec) {
      var head = sec.querySelector('.admin-panel__head');
      var body = sec.querySelector('.admin-panel__body');
      if (head) nav.appendChild(head);
      if (body) work.appendChild(body);
      sec.remove();
    });

    panels.dataset.shell = 'desktop';
    panels.replaceChildren(nav, work);
    // Every desktop CSS rule hangs off this class rather than off the media
    // query alone, so the styles cannot apply to a shell that was never built.
    document.body.classList.add('admin-desktop');

    // ARRIVE ON SOMETHING. On a phone the page opens with everything closed,
    // because a closed row still carries its count and opening one is a tap. A
    // sidebar beside an empty work area just looks broken.
    var first = ordered.length ? keyOf(ordered[0]) : null;
    return first || NAV_ORDER[0];
  }

  window.buildAdminShell = buildAdminShell;
  window.ADMIN_NAV_ORDER = NAV_ORDER;
  window.ADMIN_DESKTOP_MIN_WIDTH = DESKTOP_MIN_WIDTH;
})();
