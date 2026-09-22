/** Keep observation timing independent of entry timing, and always reconcile.
 * Both tasks settle before advancing to another market, even after a failure.
 */
export async function runMarketCycle(
  observe: () => Promise<void>,
  enter: () => Promise<void>,
  reconcile: () => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(observe),
    Promise.resolve().then(enter),
  ]);
  await reconcile();
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

