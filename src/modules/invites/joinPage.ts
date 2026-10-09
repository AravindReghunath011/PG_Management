import crypto from 'crypto';
import { Request, Response } from 'express';

/**
 * GET /join/:token — the self check-in page a new Resident opens from the
 * Owner's shared link. A plain web page (no app install): it loads the invite
 * from /api/public/invites/:token and posts the form back there. Everything is
 * inline, locked down by a per-request CSP nonce.
 */
export const serveJoinPage = (_req: Request, res: Response) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' blob: data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(PAGE.replace(/__NONCE__/g, nonce));
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<link rel="icon" href="data:,">
<title>Join your PG</title>
<style nonce="__NONCE__">
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
</style>
</head>
<body>
<header class="top"><div class="inner">
  <div class="eyebrow">Self check-in</div>
  <h1 id="pgName">Loading…</h1>
  <p class="lead" id="lead">Fill in your details to complete your check-in.</p>
</div></header>

<main class="wrap">
  <section class="card hero" id="loading"><p class="hint">Loading your invite…</p></section>

  <section class="card state" id="stateBox" hidden>
    <div class="icon" id="stateIcon"></div>
    <h2 id="stateTitle"></h2>
    <p id="stateText"></p>
  </section>

  <form id="form" novalidate hidden>
    <section class="card hero">
      <div class="grid">
        <div><div class="k">Room</div><div class="v" id="dRoom">–</div></div>
        <div><div class="k">Bed</div><div class="v" id="dBed">–</div></div>
        <div><div class="k">Move-in date</div><div class="v" id="dDate">–</div></div>
        <div><div class="k">Monthly rent</div><div class="v" id="dRent">–</div></div>
        <div><div class="k">Security deposit</div><div class="v" id="dDeposit">–</div></div>
        <div><div class="k">Link valid until</div><div class="v" id="dExpiry">–</div></div>
      </div>
    </section>

    <section class="card">
      <h2>Your photo <span class="opt k">(optional)</span></h2>
      <p class="hint">Used on your gate pass.</p>
      <div class="photoRow">
        <div class="avatar" id="photoPreview">Photo</div>
        <div class="btns">
          <button type="button" class="btn solid" data-pick="photoCamera">📷 Take photo</button>
          <button type="button" class="btn" data-pick="photoFile">Upload</button>
        </div>
      </div>
      <input class="sr" type="file" id="photoCamera" accept="image/*" capture="user" tabindex="-1">
      <input class="sr" type="file" id="photoFile" accept="image/jpeg,image/png" tabindex="-1">
      <div class="err" id="err-photo" hidden></div>
    </section>

    <section class="card">
      <h2>Personal details</h2>
      <label class="f" for="name">Full name</label>
      <input type="text" id="name" name="name" autocomplete="name" maxlength="50" placeholder="As on your ID">
      <div class="err" id="err-name" hidden></div>

      <label class="f" for="phone">Mobile number</label>
      <input type="tel" id="phone" name="phone" autocomplete="tel-national" inputmode="numeric" maxlength="10" placeholder="10-digit number">
      <div class="err" id="err-phone" hidden></div>

      <label class="f" for="email">Email <span class="opt">(optional)</span></label>
      <input type="email" id="email" name="email" autocomplete="email" placeholder="you@example.com">

      <label class="f">Food</label>
      <div class="chips" role="group" aria-label="Food preference">
        <button type="button" class="chip" data-food="with_food" aria-pressed="true">With food</button>
        <button type="button" class="chip" data-food="without_food" aria-pressed="false">Without food</button>
      </div>
    </section>

    <section class="card">
      <h2>Parent / emergency contact <span class="opt k">(optional)</span></h2>
      <label class="f" for="guardianName">Name</label>
      <input type="text" id="guardianName" name="guardianName" maxlength="50">
      <label class="f" for="guardianRelation">Relation</label>
      <input type="text" id="guardianRelation" name="guardianRelation" placeholder="Father, Mother, Brother…">
      <label class="f" for="guardianPhone">Mobile number</label>
      <input type="tel" id="guardianPhone" name="guardianPhone" inputmode="numeric" maxlength="10" placeholder="10-digit number">
      <div class="err" id="err-guardianPhone" hidden></div>
    </section>

    <section class="card">
      <h2>ID proof</h2>
      <p class="hint">Take a clear photo, or upload a JPG, PNG or PDF (max 5 MB).</p>
      <label class="f" for="kycType">ID type</label>
      <select id="kycType" name="kycType">
        <option value="Aadhaar">Aadhaar Card</option>
        <option value="Passport">Passport</option>
        <option value="DL">Driving Licence</option>
        <option value="Other">Other ID</option>
      </select>
      <label class="f" for="kycRef">ID number</label>
      <input type="text" id="kycRef" name="kycRef" autocomplete="off" maxlength="30">
      <div class="err" id="err-kycRef" hidden></div>

      <div class="doc">
        <div class="row"><span class="name">ID photo</span><span class="file" id="kycFrontName"></span></div>
        <div class="btns">
          <button type="button" class="btn solid" data-pick="kycFrontCamera">📷 Take photo</button>
          <button type="button" class="btn" data-pick="kycFrontFile">Upload file</button>
        </div>
        <img class="preview" id="kycFrontPreview" alt="ID preview" hidden>
        <div class="err" id="err-kycFront" hidden></div>
      </div>
      <input class="sr" type="file" id="kycFrontCamera" accept="image/*" capture="environment" tabindex="-1">
      <input class="sr" type="file" id="kycFrontFile" accept="image/jpeg,image/png,application/pdf" tabindex="-1">
    </section>

    <label class="check"><input type="checkbox" id="agree"> <span>I confirm these details are correct and belong to me.</span></label>
    <div class="err" id="err-agree" hidden></div>

    <div class="banner error" id="formError" hidden></div>
    <button type="submit" class="submit" id="submit">Submit &amp; check in</button>
    <p class="footer">This link works only once. Your details go only to your PG owner.</p>
  </form>
</main>

<script nonce="__NONCE__">
(function () {
  var token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  var api = '/api/public/invites/' + encodeURIComponent(token);
  var MAX_BYTES = 5 * 1024 * 1024;
  var $ = function (id) { return document.getElementById(id); };
  var files = { photo: null, kycFront: null };
  var food = 'with_food';
  var invite = null;

  var rupees = function (paise) {
    return '₹' + Math.round(paise / 100).toLocaleString('en-IN');
  };
  var date = function (iso) {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  function showState(kind, title, text) {
    $('loading').hidden = true;
    $('form').hidden = true;
    $('stateBox').hidden = false;
    $('lead').hidden = true;
    if (!invite) $('pgName').textContent = 'PG check-in';
    $('stateIcon').className = 'icon ' + (kind === 'ok' ? 'ok' : 'bad');
    $('stateIcon').textContent = kind === 'ok' ? '✓' : '!';
    $('stateTitle').textContent = title;
    $('stateText').textContent = text;
    window.scrollTo(0, 0);
  }

  function setError(field, message) {
    var box = $('err-' + field);
    if (box) { box.textContent = message || ''; box.hidden = !message; }
    var input = $(field);
    if (input && input.classList) input.classList.toggle('invalid', !!message);
  }

  // ── Load the invite ────────────────────────────────────────────
  fetch(api).then(function (r) {
    return r.json().then(function (body) { return { ok: r.ok, body: body }; });
  }).then(function (res) {
    if (!res.ok) {
      var e = (res.body && res.body.error) || {};
      var titles = { INVITE_USED: 'Link already used', INVITE_EXPIRED: 'Link expired' };
      return showState('bad', titles[e.code] || 'Link not valid', e.message || 'Ask your PG owner for a new link.');
    }
    invite = res.body;
    $('pgName').textContent = invite.pgName;
    document.title = 'Join ' + invite.pgName;
    if (!invite.bedAvailable) {
      return showState('bad', 'Bed no longer available', 'This bed has been taken. Please contact ' + (invite.ownerName || 'the PG owner') + '.');
    }
    $('dRoom').textContent = invite.roomNumber ? invite.roomNumber + (invite.floor != null ? ' · ' + (invite.floor === 0 ? 'Ground floor' : 'Floor ' + invite.floor) : '') : '–';
    $('dBed').textContent = invite.bedNumber || '–';
    $('dDate').textContent = date(invite.checkInDate);
    $('dRent').textContent = rupees(invite.monthlyRent);
    $('dDeposit').textContent = rupees(invite.securityDeposit);
    $('dExpiry').textContent = date(invite.expiresAt);
    $('loading').hidden = true;
    $('form').hidden = false;
  }).catch(function () {
    showState('bad', 'Couldn’t load', 'Check your internet connection and open the link again.');
  });

  // ── Pickers ────────────────────────────────────────────────────
  document.querySelectorAll('[data-pick]').forEach(function (btn) {
    btn.addEventListener('click', function () { $(btn.getAttribute('data-pick')).click(); });
  });

  // Phone cameras make 3–10 MB photos: shrink to ≤1600px JPEG before upload.
  function shrink(file, name) {
    if (!/^image\\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\\.(jpe?g|png|heic|heif|webp)$/i.test(file.name)) {
      return Promise.resolve(file);
    }
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          resolve(blob ? new File([blob], name + '.jpg', { type: 'image/jpeg' }) : file);
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function accept(slot, file) {
    var isPdf = file.type === 'application/pdf' || /\\.pdf$/i.test(file.name);
    var isImage = file.type === 'image/jpeg' || file.type === 'image/png';
    if (slot === 'photo' && !isImage) return 'Your photo must be a JPG or PNG.';
    if (!isImage && !isPdf) return 'Use a JPG, PNG or PDF.';
    if (file.size > MAX_BYTES) return 'This file is larger than 5 MB.';
    return null;
  }

  function wire(inputId, slot) {
    $(inputId).addEventListener('change', function (ev) {
      var original = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!original) return;
      shrink(original, slot).then(function (file) {
        var problem = accept(slot, file);
        if (problem) {
          setError(slot, problem);
          return;
        }
        files[slot] = file;
        setError(slot, '');
        var preview = file.type.indexOf('image/') === 0 ? URL.createObjectURL(file) : null;
        if (slot === 'photo') {
          var box = $('photoPreview');
          box.textContent = '';
          var img = document.createElement('img');
          img.alt = 'Your photo';
          img.src = preview;
          box.appendChild(img);
        } else {
          $(slot + 'Name').textContent = '✓ ' + (file.type === 'application/pdf' ? file.name : 'Photo added');
          var p = $(slot + 'Preview');
          p.hidden = !preview;
          if (preview) p.src = preview;
        }
      });
    });
  }
  wire('photoCamera', 'photo');
  wire('photoFile', 'photo');
  wire('kycFrontCamera', 'kycFront');
  wire('kycFrontFile', 'kycFront');

  document.querySelectorAll('[data-food]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      food = chip.getAttribute('data-food');
      document.querySelectorAll('[data-food]').forEach(function (c) {
        c.setAttribute('aria-pressed', String(c === chip));
      });
    });
  });

  ['phone', 'guardianPhone'].forEach(function (id) {
    $(id).addEventListener('input', function () { this.value = this.value.replace(/\\D/g, '').slice(0, 10); });
  });

  // An error goes away as soon as the field is touched again.
  ['name', 'phone', 'guardianPhone', 'kycRef'].forEach(function (id) {
    $(id).addEventListener('input', function () { setError(id, ''); });
  });
  $('agree').addEventListener('change', function () { setError('agree', ''); });

  // ── Submit ─────────────────────────────────────────────────────
  function validate() {
    var v = function (id) { return $(id).value.trim(); };
    var errors = {};
    if (!v('name')) errors.name = 'Enter your full name.';
    if (!/^\\d{10}$/.test(v('phone'))) errors.phone = 'Enter your 10-digit mobile number.';
    if (v('guardianPhone') && !/^\\d{10}$/.test(v('guardianPhone'))) errors.guardianPhone = 'Enter a 10-digit number, or leave it empty.';
    if (!v('kycRef')) errors.kycRef = 'Enter your ID number.';
    if (!files.kycFront) errors.kycFront = 'Add a photo of your ID.';
    if (!$('agree').checked) errors.agree = 'Please confirm your details.';
    ['photo', 'name', 'phone', 'guardianPhone', 'kycRef', 'kycFront', 'agree'].forEach(function (f) { setError(f, errors[f]); });
    var first = Object.keys(errors)[0];
    if (first) {
      var el = $('err-' + first);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return !first;
  }

  $('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('formError').hidden = true;
    if (!validate()) return;

    var data = new FormData();
    ['name', 'phone', 'email', 'guardianName', 'guardianRelation', 'guardianPhone', 'kycType', 'kycRef'].forEach(function (id) {
      data.append(id, $(id).value.trim());
    });
    data.append('foodPreference', food);
    if (files.photo) data.append('photo', files.photo, files.photo.name);
    data.append('kycFront', files.kycFront, files.kycFront.name);

    var button = $('submit');
    button.disabled = true;
    button.textContent = 'Submitting…';
    fetch(api, { method: 'POST', body: data }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    }).then(function (res) {
      if (res.ok) {
        var b = res.body;
        return showState('ok', 'You’re checked in!',
          'Welcome to ' + b.pgName + ', ' + b.name + '. Room ' + b.roomNumber + ' · Bed ' + b.bedNumber +
          ' from ' + date(b.checkInDate) + '. You can close this page.');
      }
      var e = (res.body && res.body.error) || {};
      if (res.status === 410 || e.code === 'BED_TAKEN') {
        return showState('bad', e.code === 'BED_TAKEN' ? 'Bed no longer available' : 'Link can’t be used', e.message || 'Ask your PG owner for a new link.');
      }
      $('formError').textContent = e.message || 'Something went wrong. Please try again.';
      $('formError').hidden = false;
    }).catch(function () {
      $('formError').textContent = 'Couldn’t reach the server. Check your internet and try again.';
      $('formError').hidden = false;
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Submit & check in';
    });
  });
})();
</script>
</body>
</html>`;
