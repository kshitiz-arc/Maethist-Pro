'use strict';

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = notification && notification.data ? notification.data : {};
  const date = typeof data.date === 'string' ? data.date : '';
  const fallbackUrl = '/write?planner=1' + (date ? '&date=' + encodeURIComponent(date) : '');
  const targetUrl = typeof data.url === 'string' && data.url ? data.url : fallbackUrl;

  if (notification) notification.close();

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    const writeClient = windowClients.find((client) => {
      try {
        return new URL(client.url).pathname === '/write';
      } catch (error) {
        return false;
      }
    });

    if (writeClient) {
      if ('focus' in writeClient) await writeClient.focus();
      writeClient.postMessage({
        type: 'INKYSCIB_OPEN_PLANNER',
        date: date
      });
      return;
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
