/**
 * Shortens a Solana address for display purposes.
 * @param address The public key or address string.
 * @param chars The number of characters to show at the start and end. Default is 4.
 * @returns A shortened address string like "ABCD...WXYZ".
 */
export function shortenAddress(
  address: string | undefined | null,
  chars = 4
): string {
  if (!address) {
    return "N/A";
  }
  if (address.length <= chars * 2) {
    return address;
  }
  return `${address.substring(0, chars)}...${address.substring(
    address.length - chars
  )}`;
}

/**
 * Creates a promise that resolves after a specified delay.
 * @param ms The delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
