import crypto from 'crypto';
import { Request, Response } from 'express';

import { PUBLIC_PAGE_CSS, publicPageCsp } from '../invites/publicPageStyles';

/**
 * GET /apply/:token — the reusable "apply to stay" page. The visitor picks a
 * vacant bed, fills in their details and sends a request; the Owner approves
 * or ignores it in the app. Loads from / posts to /api/public/join-links/:token.
 */
export const serveApplyPage = (_req: Request, res: Response) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy', publicPageCsp(nonce));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(PAGE.replace('__CSS__', PUBLIC_PAGE_CSS).replace(/__NONCE__/g, nonce));
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<link rel="icon" href="data:,">
<title>Apply to stay</title>
<style nonce="__NONCE__">__CSS__
  input[type=date] {
    width: 100%; height: 48px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--border);
    background: #fff; color: var(--text); font: inherit; font-size: 16px; outline: none;
  }
  .room { border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-top: 10px; }
  .room .title { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .room .num { font-weight: 700; font-size: 15px; }
  .room .meta { font-size: 12.5px; color: var(--muted); }
  .beds { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .bed { border: 1.5px solid var(--border); background: #fff; border-radius: 10px; padding: 8px 12px; font: inherit; text-align: left; cursor: pointer; min-width: 96px; }
  .bed .b { font-weight: 700; font-size: 14px; color: var(--text); }
  .bed .r { font-size: 12.5px; color: var(--muted); }
  .bed[aria-pressed=true] { border-color: var(--blue); background: var(--blue-tint); }
  .bed[aria-pressed=true] .b, .bed[aria-pressed=true] .r { color: var(--blue); }
  .chosen { background: var(--blue-tint); color: var(--blue); border-radius: 12px; padding: 12px 14px; margin-top: 14px; font-weight: 600; font-size: 14px; }
  .empty { color: var(--muted); }
</style>
</head>
<body>
<header class="top"><div class="inner">
  <div class="eyebrow">Apply to stay</div>
  <h1 id="pgName">Loading…</h1>
  <p class="lead" id="lead">Pick a bed and send your details. The owner will confirm your stay.</p>
</div></header>

<main class="wrap">
  <section class="card hero" id="loading"><p class="hint">Loading available beds…</p></section>

  <section class="card state" id="stateBox" hidden>
    <div class="icon" id="stateIcon"></div>
    <h2 id="stateTitle"></h2>
    <p id="stateText"></p>
  </section>

  <form id="form" novalidate hidden>
    <section class="card hero">
      <h2>Choose your bed</h2>
      <p class="hint" id="depositHint">Prices are per bed, per month.</p>
      <div id="branchWrap" hidden>
        <label class="f" for="branch">Property</label>
        <select id="branch"></select>
      </div>
      <div id="rooms"></div>
      <div class="chosen" id="chosen" hidden></div>
      <div class="err" id="err-bed" hidden></div>

      <label class="f" for="moveIn">When do you want to move in?</label>
      <input type="date" id="moveIn">
      <div class="err" id="err-moveIn" hidden></div>
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
      <input type="text" id="name" autocomplete="name" maxlength="50" placeholder="As on your ID">
      <div class="err" id="err-name" hidden></div>

      <label class="f" for="phone">Mobile number</label>
      <input type="tel" id="phone" autocomplete="tel-national" inputmode="numeric" maxlength="10" placeholder="10-digit number">
      <div class="err" id="err-phone" hidden></div>

      <label class="f" for="email">Email <span class="opt">(optional)</span></label>
      <input type="email" id="email" autocomplete="email" placeholder="you@example.com">

      <label class="f">Food</label>
      <div class="chips" role="group" aria-label="Food preference">
        <button type="button" class="chip" data-food="with_food" aria-pressed="true">With food</button>
        <button type="button" class="chip" data-food="without_food" aria-pressed="false">Without food</button>
      </div>
    </section>

    <section class="card">
      <h2>Parent / emergency contact <span class="opt k">(optional)</span></h2>
      <label class="f" for="guardianName">Name</label>
      <input type="text" id="guardianName" maxlength="50">
      <label class="f" for="guardianRelation">Relation</label>
      <input type="text" id="guardianRelation" placeholder="Father, Mother, Brother…">
      <label class="f" for="guardianPhone">Mobile number</label>
      <input type="tel" id="guardianPhone" inputmode="numeric" maxlength="10" placeholder="10-digit number">
      <div class="err" id="err-guardianPhone" hidden></div>
    </section>

    <section class="card">
      <h2>ID proof</h2>
      <p class="hint">Take a clear photo, or upload a JPG, PNG or PDF (max 5 MB).</p>
      <label class="f" for="kycType">ID type</label>
      <select id="kycType">
        <option value="Aadhaar">Aadhaar Card</option>
        <option value="Passport">Passport</option>
        <option value="DL">Driving Licence</option>
        <option value="Other">Other ID</option>
      </select>
      <label class="f" for="kycRef">ID number</label>
      <input type="text" id="kycRef" autocomplete="off" maxlength="30">
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
    <button type="submit" class="submit" id="submit">Send request</button>
    <p class="footer">The owner reviews every request. Your details go only to this PG.</p>
  </form>
</main>

<script nonce="__NONCE__">
(function () {
  var token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  var api = '/api/public/join-links/' + encodeURIComponent(token);
  var MAX_BYTES = 5 * 1024 * 1024;
  var $ = function (id) { return document.getElementById(id); };
  var files = { photo: null, kycFront: null };
  var food = 'with_food';
  var data = null;
  var chosenBed = null;

  var rupees = function (paise) { return '₹' + Math.round(paise / 100).toLocaleString('en-IN'); };
  var iso = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  var pretty = function (value) {
    return new Date(value + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  function showState(kind, title, text) {
    $('loading').hidden = true;
    $('form').hidden = true;
    $('stateBox').hidden = false;
    $('lead').hidden = true;
    if (!data) $('pgName').textContent = 'PG application';
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

  // ── Beds ───────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderRooms() {
    var branch = data.branches.find(function (b) { return b.id === $('branch').value; }) || data.branches[0];
    var box = $('rooms');
    box.textContent = '';
    branch.rooms.forEach(function (room) {
      var card = el('div', 'room');
      var title = el('div', 'title');
      title.appendChild(el('span', 'num', 'Room ' + room.roomNumber));
      var floor = room.floor === 0 ? 'Ground floor' : 'Floor ' + room.floor;
      title.appendChild(el('span', 'meta', floor + (room.isAc ? ' · AC' : '')));
      card.appendChild(title);
      var beds = el('div', 'beds');
      room.beds.forEach(function (bed) {
        var btn = el('button', 'bed');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(!!chosenBed && chosenBed.id === bed.id));
        btn.appendChild(el('div', 'b', 'Bed ' + bed.bedNumber));
        btn.appendChild(el('div', 'r', rupees(bed.rentPaise) + ' / mo'));
        btn.addEventListener('click', function () {
          chosenBed = { id: bed.id, label: branch.name + ' · Room ' + room.roomNumber + ' · Bed ' + bed.bedNumber, rent: bed.rentPaise };
          $('chosen').textContent = 'Selected: ' + chosenBed.label + ' — ' + rupees(bed.rentPaise) + ' / month';
          $('chosen').hidden = false;
          setError('bed', '');
          renderRooms();
        });
        beds.appendChild(btn);
      });
      card.appendChild(beds);
      box.appendChild(card);
    });
  }

  fetch(api).then(function (r) {
    return r.json().then(function (body) { return { ok: r.ok, body: body }; });
  }).then(function (res) {
    if (!res.ok) {
      var e = (res.body && res.body.error) || {};
      return showState('bad', 'Link not active', e.message || 'Ask the PG for a new link.');
    }
    data = res.body;
    $('pgName').textContent = data.pgName;
    document.title = 'Apply · ' + data.pgName;
    if (!data.branches.length) {
      return showState('bad', 'No beds free right now', 'Every bed is taken at the moment. Please check with the PG later.');
    }
    if (data.depositPaise) $('depositHint').textContent = 'Prices are per bed, per month. Usual security deposit: ' + rupees(data.depositPaise) + '.';
    if (data.branches.length > 1) {
      data.branches.forEach(function (b) {
        var option = el('option', null, b.name);
        option.value = b.id;
        $('branch').appendChild(option);
      });
      $('branchWrap').hidden = false;
      $('branch').addEventListener('change', renderRooms);
    }
    var today = new Date();
    $('moveIn').min = iso(today);
    $('moveIn').max = iso(new Date(today.getTime() + 365 * 86400000));
    $('moveIn').value = iso(today);
    renderRooms();
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
        if (problem) return setError(slot, problem);
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
  ['name', 'phone', 'guardianPhone', 'kycRef', 'moveIn'].forEach(function (id) {
    $(id).addEventListener('input', function () { setError(id, ''); });
  });
  $('agree').addEventListener('change', function () { setError('agree', ''); });

  // ── Submit ─────────────────────────────────────────────────────
  function validate() {
    var v = function (id) { return $(id).value.trim(); };
    var errors = {};
    if (!chosenBed) errors.bed = 'Choose a bed above.';
    if (!v('moveIn')) errors.moveIn = 'Choose your move-in date.';
    if (!v('name')) errors.name = 'Enter your full name.';
    if (!/^\\d{10}$/.test(v('phone'))) errors.phone = 'Enter your 10-digit mobile number.';
    if (v('guardianPhone') && !/^\\d{10}$/.test(v('guardianPhone'))) errors.guardianPhone = 'Enter a 10-digit number, or leave it empty.';
    if (!v('kycRef')) errors.kycRef = 'Enter your ID number.';
    if (!files.kycFront) errors.kycFront = 'Add a photo of your ID.';
    if (!$('agree').checked) errors.agree = 'Please confirm your details.';
    ['bed', 'moveIn', 'name', 'phone', 'guardianPhone', 'kycRef', 'kycFront', 'agree'].forEach(function (f) { setError(f, errors[f]); });
    var first = Object.keys(errors)[0];
    if (first) {
      var box = $('err-' + first);
      if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return !first;
  }

  $('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('formError').hidden = true;
    if (!validate()) return;

    var body = new FormData();
    ['name', 'phone', 'email', 'guardianName', 'guardianRelation', 'guardianPhone', 'kycType', 'kycRef'].forEach(function (id) {
      body.append(id, $(id).value.trim());
    });
    body.append('foodPreference', food);
    body.append('bedId', chosenBed.id);
    body.append('preferredCheckInDate', new Date($('moveIn').value + 'T12:00:00').toISOString());
    if (files.photo) body.append('photo', files.photo, files.photo.name);
    body.append('kycFront', files.kycFront, files.kycFront.name);

    var button = $('submit');
    button.disabled = true;
    button.textContent = 'Sending…';
    fetch(api, { method: 'POST', body: body }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    }).then(function (res) {
      if (res.ok) {
        return showState('ok', 'Request sent!',
          'Thanks, ' + res.body.name + '. You asked for Room ' + res.body.roomNumber + ' · Bed ' + res.body.bedNumber +
          ' from ' + pretty($('moveIn').value) + '. The owner will review it and contact you.');
      }
      var e = (res.body && res.body.error) || {};
      if (e.code === 'LINK_NOT_FOUND') return showState('bad', 'Link not active', e.message);
      if (e.code === 'BED_TAKEN') {
        var takenId = chosenBed.id;
        data.branches.forEach(function (b) {
          b.rooms.forEach(function (r) { r.beds = r.beds.filter(function (x) { return x.id !== takenId; }); });
          b.rooms = b.rooms.filter(function (r) { return r.beds.length > 0; });
        });
        chosenBed = null;
        renderRooms();
        $('chosen').hidden = true;
        setError('bed', e.message);
        if ($('err-bed').scrollIntoView) $('err-bed').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      $('formError').textContent = e.message || 'Something went wrong. Please try again.';
      $('formError').hidden = false;
    }).catch(function () {
      $('formError').textContent = 'Couldn’t reach the server. Check your internet and try again.';
      $('formError').hidden = false;
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Send request';
    });
  });
})();
</script>
</body>
</html>`;
