type CheckoutPage = { html: string; contentSecurityPolicy: string };

const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';
const PADDLE_JS_ORIGIN = 'https://cdn.paddle.com';
// Paddle documents no CSP list; the overlay frame and its API calls live on paddle.com subdomains.
const PADDLE_SOURCES = 'https://*.paddle.com';

// style-src allows inline styles because Paddle.js styles the overlay it injects.
const contentSecurityPolicyOf = (nonce: string): string =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${PADDLE_JS_ORIGIN}`,
    `frame-src ${PADDLE_SOURCES}`,
    `connect-src ${PADDLE_SOURCES}`,
    `style-src 'unsafe-inline' ${PADDLE_SOURCES}`,
    `img-src ${PADDLE_SOURCES} data:`,
    `font-src ${PADDLE_SOURCES}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

// Paddle.js opens the checkout for the _ptxn query parameter by itself.
const checkoutPageOf = (clientToken: string, nonce: string): CheckoutPage => ({
  html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PayVolok checkout</title>
    <script nonce="${nonce}" src="${PADDLE_JS_URL}"></script>
  </head>
  <body>
    <script nonce="${nonce}">
      Paddle.Environment.set('sandbox');
      Paddle.Initialize({ token: ${JSON.stringify(clientToken)} });
    </script>
  </body>
</html>
`,
  contentSecurityPolicy: contentSecurityPolicyOf(nonce),
});

export { checkoutPageOf, PADDLE_JS_URL };
export type { CheckoutPage };
