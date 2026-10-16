/** Shared look of the public pages (/join and /apply): the app's palette, mobile-first. */
export const PUBLIC_PAGE_CSS = `
  :root {
    --page: #F4F5FB; --card: #FFFFFF; --border: #E6E8F0; --text: #0F172A; --muted: #64748B;
    --faint: #94A3B8; --blue: #1F55C0; --blue-tint: #EAF1FE; --green: #16A34A; --green-tint: #E8F7EE;
    --red: #DC2626; --red-tint: #FEF2F2; --radius: 14px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--page); color: var(--text);
    font: 15px/1.45 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 560px; margin: 0 auto; padding: 0 16px 40px; }
  header.top { background: var(--blue); color: #fff; padding: 28px 16px 64px; }
  header.top .inner { max-width: 560px; margin: 0 auto; }
  .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; opacity: .8; }
  h1 { font-size: 24px; line-height: 1.2; margin: 6px 0 4px; }
  .lead { opacity: .9; margin: 0; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; margin-top: 14px; }
  .card.hero { margin-top: -44px; box-shadow: 0 8px 24px rgba(15,23,42,.08); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 12px; }
  .k { font-size: 12px; color: var(--muted); font-weight: 500; }
  .v { font-size: 16px; font-weight: 700; margin-top: 2px; }
  h2 { font-size: 16px; margin: 0 0 4px; }
  .hint { font-size: 13px; color: var(--muted); margin: 0 0 14px; }
  label.f { display: block; font-size: 13.5px; font-weight: 600; margin: 14px 0 6px; }
  label.f .opt { color: var(--faint); font-weight: 500; }
  input[type=text], input[type=tel], input[type=email], select {
    width: 100%; height: 48px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--border);
    background: #fff; color: var(--text); font: inherit; font-size: 16px; outline: none;
  }
  input:focus, select:focus { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-tint); }
  .invalid { border-color: var(--red) !important; }
  .err { color: var(--red); font-size: 13px; margin-top: 6px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--border); background: #fff; border-radius: 999px; padding: 9px 14px; font: inherit; font-weight: 600; font-size: 14px; color: var(--text); cursor: pointer; }
  .chip[aria-pressed=true] { background: var(--blue); border-color: var(--blue); color: #fff; }
  .photoRow { display: flex; gap: 16px; align-items: center; }
  .avatar { width: 84px; height: 84px; border-radius: 50%; background: var(--blue-tint); border: 2px dashed #B8CBF5; flex: none; overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--blue); font-weight: 700; font-size: 13px; }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 42px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--border); background: #fff; color: var(--blue); font: inherit; font-weight: 600; font-size: 14px; cursor: pointer; }
  .btn.solid { background: var(--blue-tint); border-color: transparent; }
  .doc { border: 1.5px dashed #C9D6F2; border-radius: 12px; padding: 14px; margin-top: 10px; }
  .doc .row { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; }
  .doc .name { font-weight: 600; font-size: 14px; }
  .doc .file { font-size: 13px; color: var(--green); font-weight: 600; word-break: break-all; }
  .doc img.preview { display: block; max-width: 100%; max-height: 180px; border-radius: 8px; margin-top: 10px; }
  .check { display: flex; gap: 10px; align-items: flex-start; margin-top: 16px; font-size: 14px; }
  .check input { width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--blue); flex: none; }
  .submit { width: 100%; height: 54px; border: 0; border-radius: 14px; background: var(--blue); color: #fff; font: inherit; font-size: 16px; font-weight: 700; margin-top: 18px; cursor: pointer; }
  .submit:disabled { opacity: .6; }
  .banner { border-radius: 12px; padding: 12px 14px; font-size: 14px; margin-top: 14px; }
  .banner.error { background: var(--red-tint); color: var(--red); }
  .state { text-align: center; padding: 48px 20px; }
  .state .icon { width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 14px; display: flex; align-items: center; justify-content: center; font-size: 30px; }
  .state .icon.ok { background: var(--green-tint); color: var(--green); }
  .state .icon.bad { background: var(--red-tint); color: var(--red); }
  .state h2 { font-size: 20px; margin-bottom: 6px; }
  .state p { color: var(--muted); margin: 0 auto; max-width: 360px; }
  .footer { text-align: center; color: var(--faint); font-size: 12px; margin-top: 22px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  [hidden] { display: none !important; }
`;

/** Strict CSP for a public page whose inline <style>/<script> carry `nonce`. */
export function publicPageCsp(nonce: string) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
