// Public values only: publishable keys are meant for browsers, and what they can read is
// decided by the database policies. The same files are served locally and from the
// static hosting, so the environment is picked by the address the page was opened on.
(function () {
  const local = ['127.0.0.1', 'localhost'].includes(window.location.hostname);

  window.APP_CONFIG = local
    ? {
        supabaseUrl: 'http://127.0.0.1:54321',
        supabaseKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
        // The seeded test user only exists in the local database.
        passwordLogin: true,
      }
    : {
        supabaseUrl: 'https://uxobdhwnmcfutyithpve.supabase.co',
        supabaseKey: 'sb_publishable_dV3LLgaD6Cm4jngp6O0ibg_CXYUZY21',
        passwordLogin: false,
      };
})();
