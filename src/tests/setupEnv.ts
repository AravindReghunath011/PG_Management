// Most suites sign up an owner and use it straight away (the default).
// signupApproval.test.ts switches approval on to cover that path.
process.env.OWNER_SIGNUP_REQUIRES_APPROVAL = 'false';
