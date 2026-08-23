import fieldPolicy from "./browserFieldPolicy.cjs";

export const { SENSITIVE_FIELD_PATTERN, SENSITIVE_FIELD_SNIPPET, isSensitiveFieldSignature } = fieldPolicy;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function validateBrowserUrl(value, { allowLocalHttp = true } = {}) {
  let url;
  try { url = new URL(String(value || "")); } catch { return { ok:false, reason:"Geçersiz URL" }; }
  if (url.protocol === "https:") return { ok:true, url:url.href };
  if (allowLocalHttp && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return { ok:true, url:url.href };
  return { ok:false, reason:"Yalnız HTTPS ve yerel HTTP adreslerine izin verilir" };
}

const REDACTIONS = [
  [/\b(?:authorization|x-csrf-token|csrf|bearer|token|api[_ -]?key|client[_ -]?secret|recovery[_ -]?code)\s*[:=]?\s*\S+/gi, "[REDACTED]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED-EMAIL]"],
  [/(?<!\d)(?:\+?\d[\s().-]*){10,15}(?!\d)/g, "[REDACTED-PHONE]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED-CARD]"],
  [/\b(?:\d[\s-]?){6,10}\b/g, "[REDACTED-CODE]"],
  [/\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?|[A-F0-9]{32,}|[A-Za-z0-9_-]{40,})\b/gi, "[REDACTED-TOKEN]"],
];
export function redactText(value, limit=120_000) { let text=String(value||""); for(const [pattern,replacement] of REDACTIONS) text=text.replace(pattern,replacement); return text.slice(0,limit); }
export function redactBrowserSnapshot(snapshot={}) { return { title:redactText(snapshot.title,500), url:String(snapshot.url||"").slice(0,4000), text:redactText(snapshot.text), elements:Array.isArray(snapshot.elements)?snapshot.elements.slice(0,200).map((e)=>({id:String(e.id||"").slice(0,80),role:String(e.role||"").slice(0,40),label:redactText(e.label,300)})):[] }; }

export function browserSnapshotScript() {
  return `(() => { ${SENSITIVE_FIELD_SNIPPET} const blocked='input, textarea, select, [contenteditable], [data-private], [aria-label*=password i], [aria-label*=token i], [aria-label*=code i]'; const clone=document.documentElement.cloneNode(true); clone.querySelectorAll('script, style, noscript, template, svg, canvas, '+blocked).forEach((node)=>node.remove()); const selector='a[href], button, [role=button], input, textarea, [contenteditable=true]'; const elements=[...document.querySelectorAll(selector)].filter((node)=>{const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&!sensitive(node)}).slice(0,200).map((node,index)=>({id:'e'+index,role:node.tagName.toLowerCase(),label:(node.innerText||node.getAttribute('aria-label')||node.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().slice(0,300)})); return {title:document.title,url:location.href,text:(clone.innerText||clone.textContent||'').replace(/\\s+/g,' ').trim(),elements}; })()`;
}
