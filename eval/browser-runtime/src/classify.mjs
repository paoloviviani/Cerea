// ADR 0116 s4 action classification, computed from element metadata BEFORE an action runs.
const COMMIT_NAME = /\b(pay|buy|order|send|delete|remove|confirm|publish|sign|submit|transfer|purchase)\b/i;
export async function elementMeta(locator) {
  return locator.evaluate((el) => ({
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), role: el.getAttribute('role'),
    name: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
    inForm: !!el.closest('form'), href: el.href || null, download: el.hasAttribute('download'),
  }));
}
export function classify(action, meta, currentUrl) {
  const origin = (u) => { try { return new URL(u, currentUrl).origin; } catch { return null; } };
  switch (action.kind) {
    case 'navigate': return origin(action.url) === origin(currentUrl) ? 'read' : 'commit';
    case 'scroll': case 'wait': case 'extract': return 'read';
    case 'fill': case 'select': return 'input';
    case 'press': return action.key === 'Enter' ? 'commit' : 'input'; // Enter may submit a form
    case 'click': {
      if (!meta) return 'commit'; // unknown element: fail closed
      if (meta.href && origin(meta.href) !== origin(currentUrl)) return 'commit';
      if (meta.download) return 'commit';
      if (meta.tag === 'button' || meta.tag === 'input') {
        const submit = meta.type === 'submit' || (meta.tag === 'button' && !meta.type && meta.inForm);
        if (submit) return 'commit';
      }
      if (COMMIT_NAME.test(meta.name || '')) return 'commit';
      return meta.tag === 'a' ? 'read' : 'input';
    }
    default: return 'commit';
  }
}
