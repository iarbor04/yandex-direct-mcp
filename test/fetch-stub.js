'use strict';

// Подменяет fetch для тестов: в сеть ничего не уходит, ответ содержит адрес, на который ушёл бы запрос.
globalThis.fetch = async (url) => {
  const isReport = url.endsWith('/reports');
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'units' ? '0/0/0' : null) },
    text: async () => (isReport ? `URL\n${url}\n` : JSON.stringify({ result: { url } })),
  };
};
