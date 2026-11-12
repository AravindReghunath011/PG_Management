/**
 * Browser-side checks shared by the public self check-in (/join) and apply
 * (/apply) pages. Same rules as the owner app's Add Tenant form
 * (pgManagementFrontend validation.ts), so a Resident gets the same help
 * whether they fill the form themselves or the Owner does.
 *
 * Plain ES5 for old phone browsers. Inlined into each page's <script>.
 */
export const PUBLIC_FORM_CHECKS = String.raw`
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** Keeps only what each ID type allows while the person types. */
  function cleanKycRef(type, value) {
    if (type === 'Aadhaar') return value.replace(/\D/g, '').slice(0, 12);
    if (type === 'Passport') return value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8);
    if (type === 'DL') return value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 16);
    return value.slice(0, 30);
  }

  function kycRefError(type, raw) {
    if (!raw) return '';
    if (type === 'Aadhaar' && raw.length !== 12) return 'Aadhaar number must have 12 digits.';
    if (type === 'Aadhaar' && /^[01]/.test(raw)) return 'Aadhaar number cannot start with 0 or 1.';
    if (type === 'Passport' && !/^[A-Z][0-9]{7}$/.test(raw)) return 'Passport number looks like A1234567.';
    if (type === 'DL' && raw.length < 10) return 'Enter the full licence number.';
    return '';
  }

  function phoneError(phone) {
    if (!/^\d{10}$/.test(phone)) return 'Enter your 10-digit mobile number.';
    if (!/^[6-9]/.test(phone)) return 'Mobile numbers start with 6, 7, 8 or 9.';
    return '';
  }

  /** Errors for the personal, contact and ID fields, keyed by input id. */
  function checkDetails(v) {
    var errors = {};
    if (!v('name')) errors.name = 'Enter your full name.';
    var phone = phoneError(v('phone'));
    if (phone) errors.phone = phone;
    if (v('email') && !EMAIL_RE.test(v('email'))) errors.email = 'Enter a correct email, like name@gmail.com.';
    var gp = v('guardianPhone');
    if (gp) {
      var g = phoneError(gp);
      if (g) errors.guardianPhone = g;
      else if (gp === v('phone')) errors.guardianPhone = 'Use a different number from your own.';
      if (!v('guardianName')) errors.guardianName = 'Add their name.';
    }
    var kyc = kycRefError(v('kycType'), v('kycRef'));
    if (kyc) errors.kycRef = kyc;
    return errors;
  }

  /** Live clean-up of the number fields; call once after the page loads. */
  function wireDetailInputs($, setError) {
    ['phone', 'guardianPhone'].forEach(function (id) {
      $(id).addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 10); });
    });
    $('kycRef').addEventListener('input', function () { this.value = cleanKycRef($('kycType').value, this.value); });
    $('kycType').addEventListener('change', function () {
      $('kycRef').value = '';
      $('kycRef').inputMode = this.value === 'Aadhaar' ? 'numeric' : 'text';
      $('kycRef').placeholder = { Aadhaar: '12-digit number', Passport: 'e.g. A1234567', DL: 'Licence number' }[this.value] || 'ID number';
      setError('kycRef', '');
    });
    ['name', 'phone', 'email', 'guardianName', 'guardianPhone', 'kycRef'].forEach(function (id) {
      $(id).addEventListener('input', function () { setError(id, ''); });
    });
  }
`;
