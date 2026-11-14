/*
 * TripNavigate closed-browser alerts (Accounts phase 3, contract 8.4).
 * Plain JavaScript: no imports, no caching, no fetch handler. Registered only
 * after the person presses "Turn on alerts on this device".
 *
 * push: always shows one notification {title, body, tag} whose click opens
 *   data.url, even when a CRM tab is focused (Addendum O3: WebKit ends a
 *   subscription after silent pushes). The tag collapses duplicates. The
 *   body is the bell text (references only).
 * notificationclick: focuses an open CRM tab and navigates it to the notice,
 *   else opens a new window. The URL is always a same-origin path (checked);
 *   anything else opens /app.
 */
'use strict';

function safePath(value) {
  if (typeof value !== 'string' || value.length > 500) return '/app';
  if (!/^\/(?![/\\])[^\s\\]*$/.test(value)) return '/app';
  return value;
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// Take control of open CRM tabs at once so a click can navigate them (no caching, no fetch handler).
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  var title = text(data.title, 60) || 'TripNavigate';
  var body = text(data.body, 200);
  var tag = text(data.tag, 80) || 'tn-notice';
  var url = safePath(data.url);
  // Always shown (Addendum O3): iPhone / WebKit ends a subscription after silent pushes. The tag collapses
  // duplicates of one notice into one notification.
  event.waitUntil(self.registration.showNotification(title, { body: body, tag: tag, data: { url: url } }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = safePath(event.notification.data && event.notification.data.url);
  var target = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i += 1) {
        var c = list[i];
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          return c
            .focus()
            .then(function (focused) {
              return focused.navigate(target);
            })
            .catch(function () {
              return self.clients.openWindow(target);
            });
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
