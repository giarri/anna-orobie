(function () {
  const SEEN_KEY = 'orobie-install-prompt-seen';
  let deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  }

  function markSeen() {
    localStorage.setItem(SEEN_KEY, '1');
  }

  function showBanner({ ios }) {
    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.innerHTML = `
      <span class="install-banner-icon">⛰️</span>
      <div class="install-banner-text">
        <strong>Installa Le Orobie di Anna</strong>
        <span>${ios ? 'Tocca Condividi, poi “Aggiungi a Home”' : 'Aggiungila alla home per usarla come un’app'}</span>
      </div>
      ${ios ? '' : '<button id="install-accept" type="button">Installa</button>'}
      <button id="install-dismiss" type="button" aria-label="Chiudi">✕</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('install-dismiss').addEventListener('click', () => banner.remove());

    if (!ios) {
      document.getElementById('install-accept').addEventListener('click', async () => {
        banner.remove();
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
      });
    }
  }

  if (isStandalone() || localStorage.getItem(SEEN_KEY) === '1') return;

  if (isIOS()) {
    window.addEventListener('load', () => {
      showBanner({ ios: true });
      markSeen();
    });
  } else {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredPrompt = event;
      showBanner({ ios: false });
      markSeen();
    });
  }
})();
