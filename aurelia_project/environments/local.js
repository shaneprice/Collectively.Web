export default {
  debug: true,
  testing: true,
  title: 'Coolector [Local]',
  apiUrl: 'http://localhost:5000/',
  websocketUrl: 'http://localhost:15000',
  sessionStorageKey: 'session',
  filtersStorageKey: 'filters',
  locationStorageKey: 'location',
  defaultLanguage: 'en',
  constraints: {
    remarkPhotosLimit: 5
  },
  feature: {
    resolveRemarkPhotoRequired: false,
    resolveRemarkLocationRequired: false
  },
  facebook: {
    appId: '1827532267461737'
  },
  logLevel: 'info'
};
