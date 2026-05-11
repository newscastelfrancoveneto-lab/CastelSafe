// Unico handler PUSH
self.addEventListener('push', event => {
  const data = event.data?.json() || {};

  const title = data.title || 'Nuova Allerta';
  const options = {
    body: data.body || '',
    tag: data.tag || 'arpav',
    icon: 'icon-192.png',
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

  // 1. Salva in IndexedDB
  try {
    const db = await openDB();
    const tx = db.transaction('notifications', 'readwrite');
    tx.objectStore('notifications').add(notif);
  } catch (e) {
    console.error('Salvataggio IndexedDB fallito', e);
  }

  // 2. Invia alla pagina aperta (se c'è), con flag per ricaricare le chiusure
  const channel = new BroadcastChannel('notifications-channel');
  channel.postMessage({ ...notif, type: 'RELOAD_CLOSURES' });
}
