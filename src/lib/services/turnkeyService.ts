/**
 * Turnkey client — browser-side fetch wrapper.
 *
 * Credentials live in .env (server-only). This module never touches them;
 * it delegates all signing to the /api/turnkey server route.
 */

export interface TurnkeyWallet {
  address: string;
}

/** Verify the server has Turnkey configured and return the wallet address. */
export async function connectTurnkeyWallet(): Promise<TurnkeyWallet> {
  const res = await fetch("/api/turnkey");
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg);
  }
  const { address } = (await res.json()) as { address: string };
  return { address };
}

/**
 * Send a batch of raw transactions via the Turnkey server route.
 * Transactions are signed and broadcast sequentially server-side.
 * Returns the hash of the last transaction.
 */
export async function sendViaTurnkey(
  transactions: Array<{ to: string; data: string; gas?: number }>,
  chainId: number,
): Promise<string> {
  const res = await fetch("/api/turnkey", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions, chainId }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg);
  }
  const { txHash } = (await res.json()) as { txHash: string };
  return txHash;
}
