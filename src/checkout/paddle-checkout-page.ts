import type { PaddleEnvironment } from '@/providers/provider-credentials';

type CheckoutPage = { html: string; contentSecurityPolicy: string };

type PaddleCheckout = { clientToken: string; environment: PaddleEnvironment };

// Paddle.js runs live unless it is told to use the sandbox.
const ENVIRONMENT_SETUP: Readonly<Record<PaddleEnvironment, string | null>> = {
  sandbox: "Paddle.Environment.set('sandbox');",
  live: null,
};

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

const setupScriptOf = ({ clientToken, environment }: PaddleCheckout): string =>
  [
    ENVIRONMENT_SETUP[environment],
    `Paddle.Initialize({ token: ${JSON.stringify(clientToken)} });`,
  ]
    .filter((line) => line !== null)
    .join('\n      ');

// Paddle.js opens the checkout for the _ptxn query parameter by itself.
const checkoutPageOf = (
  checkout: PaddleCheckout,
  nonce: string,
): CheckoutPage => ({
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
      ${setupScriptOf(checkout)}
    </script>
  </body>
</html>
`,
  contentSecurityPolicy: contentSecurityPolicyOf(nonce),
});

export { checkoutPageOf, PADDLE_JS_URL };
export type { CheckoutPage };
