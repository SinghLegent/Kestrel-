// Tiny DOM + fetch helpers. Never uses innerHTML, so user text cannot inject markup.
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v; // CSSOM is allowed under CSP; the attribute is not
    else if (['value', 'checked', 'disabled', 'muted', 'autoplay', 'playsInline', 'selected'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export async function api(path, body) {
  const r = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'error'), { status: r.status });
  return data;
}

export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 4500);
}

const KEY = 'km.meetings';
export const store = {
  all() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } },
  save(m) { const a = this.all(); a[m.id] = { ...a[m.id], ...m }; localStorage.setItem(KEY, JSON.stringify(a)); },
  get(id) { return this.all()[id]; },
  remove(id) { const a = this.all(); delete a[id]; localStorage.setItem(KEY, JSON.stringify(a)); },
  name() { return localStorage.getItem('km.name') || ''; },
  setName(n) { localStorage.setItem('km.name', n); },
};

export const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
export const CODE_RE = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i;
