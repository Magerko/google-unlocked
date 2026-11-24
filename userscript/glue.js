const fetchNotice = (id) =>
  new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://lumendatabase.org/notices/' + id,
      anonymous: false,
      onload: (r) => resolve({ status: r.status, url: r.finalUrl || 'https://lumendatabase.org/notices/' + id, html: r.responseText }),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout')),
    });
  });

const storage = {
  async get(key) {
    return GM_getValue(key, undefined);
  },
  async set(key, val) {
    GM_setValue(key, val);
  },
};

globalThis.GoogleUnlocked.run({ document, location, fetchNotice, storage });
