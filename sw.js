const CACHE = "gpn-v50";

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./firebase-config.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");
importScripts("./firebase-config.js");

if (typeof firebaseConfig !== "undefined" && firebaseConfig.projectId && firebaseConfig.projectId !== "YOUR_PROJECT_ID") {
  firebase.initializeApp(firebaseConfig);
  firebase.messaging();
  // Background alerts use the notification payload from the server — do not call
  // showNotification here or each push appears twice.
}

self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  const data = event.notification.data || {};
  let docId = data.docId || "";
  const pushType = data.type || "";
  if (!docId && event.notification.tag && event.notification.tag.indexOf("chat-") !== 0 && event.notification.tag !== "gpn-push") {
    docId = event.notification.tag;
  }
  let url = "./index.html";
  if (pushType === "team_chat") {
    url += "?tab=team&type=team_chat";
  } else if (docId) {
    url += "?job=" + encodeURIComponent(docId);
    if (pushType) url += "&type=" + encodeURIComponent(pushType);
  }
  const targetUrl = new URL(url, self.location.href).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if ("focus" in client) {
          if ("navigate" in client) {
            return client.focus().then(function() {
              return client.navigate(targetUrl);
            });
          }
          client.focus();
          client.postMessage({
            type: "openPush",
            pushType: pushType,
            docId: docId,
            tab: pushType === "team_chat" ? "team" : ""
          });
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("install", function(event) {
  event.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return Promise.all(
        ASSETS.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn("SW cache skip:", url, err);
          });
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function(event) {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!/\.(html|js|json|png|svg)$/.test(url.pathname) && !url.pathname.endsWith("/citi/")) return;

  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(function(cache) {
          cache.put(event.request, copy);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request).then(function(cached) {
        return cached || caches.match("./index.html");
      });
    })
  );
});
