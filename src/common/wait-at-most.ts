const waitAtMost = async (
  work: Promise<void>,
  timeoutMs: number,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([work.then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

export { waitAtMost };
