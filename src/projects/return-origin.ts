const OPAQUE_ORIGIN = 'null';

const originOf = (url: string): string | null => {
  if (!URL.canParse(url)) return null;

  const { origin } = new URL(url);

  return origin === OPAQUE_ORIGIN ? null : origin;
};

// Exact origins: a prefix compare would let https://shop.example.evil.test through.
const isReturnOriginAllowed = (
  returnUrl: string,
  allowedOrigins: readonly string[],
): boolean => {
  const returnOrigin = originOf(returnUrl);
  if (returnOrigin === null) return false;

  return allowedOrigins.some((entry) => originOf(entry) === returnOrigin);
};

export { isReturnOriginAllowed };
