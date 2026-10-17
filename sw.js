// Card Play admin service worker: background push (Firebase Cloud Messaging) + notification clicks
importScripts(
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
);
firebase.initializeApp({
  apiKey: "AIzaSyARNJOPAycWU3YJdZSBN1d9uoLrvso3i4Y",
  authDomain: "cd-card-87365.firebaseapp.com",
  projectId: "cd-card-87365",
  storageBucket: "cd-card-87365.firebasestorage.app",
  messagingSenderId: "397926299412",
  appId: "1:397926299412:web:2c82ba4a13e3c4f168f401"
});
firebase.messaging(); // shows "notification" payloads automatically when the panel is closed/hidden

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", e => {
  if (e.notification.data && e.notification.data.FCM_MSG) return; // handled by Firebase
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if (c.url.includes("admin")) { await c.focus(); return; } }
    await self.clients.openWindow("admin.html");
  })());
});
