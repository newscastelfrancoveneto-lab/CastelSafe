// Versione del Service Worker: cambiare questa stringa ad OGNI deploy che
// modifica index.html (o altri asset), anche se sw.js non cambia altrimenti.
// È l'unico modo per cui il browser rileva una nuova versione disponibile e
// mostra il badge "Aggiornamento disponibile" nell'app.
const APP_VERSION = '2026-07-23-09';

// Cache dedicata alle icone usate dalle notifiche: le pre-carichiamo così
// sono sempre disponibili anche se la rete è debole/assente nel momento
// esatto in cui arriva la push (es. durante un evento meteo), evitando che
// il sistema mostri un'icona generica al posto di quella dell'app.
const ICON_CACHE = 'castelsafe-icons-' + APP_VERSION;
const ICON_URLS = ['icon-192.png', 'icon-512.png', 'badge-96.png'];

// Cache dell'app shell (la pagina principale): senza questa, ad ogni apertura
// da chiusa (cold start) il browser deve per forza andare in rete prima di
// poter disegnare qualunque cosa, restando bloccato sulla schermata nativa
// di splash della PWA se la rete è lenta a partire — il timeout di sicurezza
// a 15s dentro index.html non può aiutare qui, perché scatta dentro la
// pagina stessa, che a quel punto non è ancora arrivata. Da background
// invece la pagina resta viva in memoria e il problema non si presenta mai
// (comportamento osservato: si blocca solo da chiusa, mai da background).
const SHELL_CACHE = 'castelsafe-shell-' + APP_VERSION;
const SHELL_URL = self.registration.scope;

self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(ICON_CACHE).then(cache => cache.addAll(ICON_URLS)).catch(() => {}),
      caches.open(SHELL_CACHE).then(cache => cache.add(SHELL_URL)).catch(() => {})
    ])
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k.startsWith('castelsafe-icons-') && k !== ICON_CACHE).map(k => caches.delete(k)))
      ),
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k.startsWith('castelsafe-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)))
      ),
      // Senza questo, dopo skipWaiting() il nuovo SW si attiva ma non prende
      // il controllo delle pagine già aperte: 'controllerchange' non scatta
      // mai lì, quindi il reload dopo aver premuto "Aggiorna" non parte e il
      // banner resta bloccato a schermo senza che succeda nulla.
      self.clients.claim()
    ])
  );
});

// Serve le icone dalla cache locale quando disponibili, evitando di dipendere
// dalla rete per mostrare l'icona nelle notifiche.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (ICON_URLS.some(name => url.pathname.endsWith(name))) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Navigazione verso l'app (apertura da icona Home): cache-first per un
  // avvio sempre istantaneo, con aggiornamento della cache in background così
  // la prossima apertura ha comunque l'ultima versione scaricata con successo.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match(SHELL_URL).then(cached => {
        const network = fetch(event.request).then(response => {
          if (response && response.ok) {
            caches.open(SHELL_CACHE).then(cache => cache.put(SHELL_URL, response.clone()));
          }
          return response;
        }).catch(() => null);
        return cached || network;
      })
    );
  }
});

// Unico handler PUSH
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch (e) {
    console.error('Payload push non valido (non JSON):', e);
    data = { title: 'Nuova Allerta', body: event.data?.text() || '' };
  }

  const iconUrl = new URL('icon-192.png', self.registration.scope).href;
  const badgeUrl = new URL('badge-96.png', self.registration.scope).href;
  const title = data.title || 'Nuova Allerta';
  const options = {
    body: data.body || '',
    tag: data.tag || 'arpav',
    renotify: data.renotify || false,
    icon: iconUrl,
    badge: badgeUrl,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/CastelSafe/' }
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      saveAndBroadcastNotification(data)
    ])
  );
});

// Click sulla notifica: apre/focus l'app e triggera reload chiusure
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.notification.data?.type === 'app-update') {
    event.waitUntil(
      self.registration.waiting
        ? Promise.resolve(self.registration.waiting.postMessage({ type: 'SKIP_WAITING' }))
        : Promise.resolve()
    );
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Manda messaggio a tutti i client aperti per ricaricare le chiusure
      clientList.forEach(client => {
        client.postMessage({ type: 'RELOAD_CLOSURES' });
      });
      // Se c'è già una finestra aperta, mettila in focus
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      // Altrimenti apri una nuova finestra
      return clients.openWindow(event.notification.data?.url || '/CastelSafe/');
    })
  );
});

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('NotificheDB', 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('notifications')) {
        db.createObjectStore('notifications', { autoIncrement: true });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      resolve({
        transaction(storeName, mode) {
          const tx = db.transaction(storeName, mode);
          return {
            objectStore(name) {
              const store = tx.objectStore(name);
              return {
                add(item) {
                  return new Promise((res, rej) => {
                    const req = store.add(item);
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => rej(req.error);
                  });
                }
              };
            }
          };
        }
      });
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

// Salva + Broadcast al client
async function saveAndBroadcastNotification(data) {
  const notif = {
    title: data.title || 'Nuova Allerta',
    body: data.body || '',
    timestamp: new Date().toLocaleString('it-IT')
  };

  try {
    const db = await openDB();
    const tx = db.transaction('notifications', 'readwrite');
    tx.objectStore('notifications').add(notif);
  } catch (e) {
    console.error('Salvataggio IndexedDB fallito', e);
  }

  // BroadcastChannel non esiste su iOS sotto il 15.4: senza questo controllo,
  // su quei dispositivi la notifica verrebbe comunque mostrata da
  // showNotification() ma la Promise.all() nel gestore 'push' finirebbe
  // rigettata da un ReferenceError qui, invece che risolversi pulita.
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('notifications-channel');
    channel.postMessage({ ...notif, type: 'RELOAD_CLOSURES' });
    channel.close();
  }
}

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Il browser può invalidare/ruotare la subscription push in autonomia
// (scadenza, rotazione chiavi FCM, ecc.). Senza ri-sottoscrivere e
// ri-inviare al backend, l'app resta con permesso "concesso" ma non
// riceve più nulla: da qui il bug "notifiche smesse di funzionare".
const API_BASE = 'https://andrea.tail04be23.ts.net';
const VAPID_PUBLIC = 'BEzNrOFRNEPdjown9Tnj2pYnQ-v464zvxjFwE_B5PEqSNIloti9MafJKsBHU1LjxTW9U2UX8TqvhP0ydySOl8Qk';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
    }).then(sub =>
      fetch(API_BASE + '/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
        mode: 'cors'
      })
    ).catch(e => console.error('Ri-subscribe fallita:', e))
  );
});
