export interface DeviceHubAccess {
  readonly httpBase: string;
  readonly wsBase: string;
  readonly query: Readonly<Record<string, string>>;
  readonly credentials: boolean;
  /**
   * The environment descriptor's E2EE fingerprint. Set only when the connection
   * prepared it, so device sockets may run the same handshake /ws does; absent
   * on servers without the identity, which keeps these sockets plaintext.
   */
  readonly e2eeFingerprint?: string;
}

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};
