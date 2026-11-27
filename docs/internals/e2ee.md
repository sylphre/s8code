# End-to-end encryption

The relay path is the one place a third party can sit in the middle of an
S8 Code session: a client connects out to a relay (T3 Connect), the relay
terminates TLS, and traffic continues to the server over a tunnel. TLS
protects each hop, but the relay operator can read everything that passes
through. The E2EE layer closes that hole at the application level. The
server itself is the endpoint and is trusted — it is the user's own
machine — so this is protection against the path, not against the server.

## Server identity

The server holds one identity secret (`e2ee-identity-key` in the secret
store): an Ed25519 signing key and an X25519 static key, 64 bytes in all.
Its fingerprint is `sha256(signing public || static public)`, base64url,
published in the environment descriptor as `e2eeFingerprint`. Clients pin
that fingerprint the same way they pin it during pairing, so a relay that
swaps in its own server key is detected at the handshake.

## The /ws channel

Opt-in per connection with the `e2ee=1` query parameter; clients that do
not ask connect exactly as before.

- The client's first frame is a hello carrying an ephemeral X25519 public
  key. The server answers with an accept whose payload (its static and
  ephemeral public keys plus an Ed25519 signature over the transcript) is
  encrypted under a handshake key derived from the first Diffie-Hellman
  exchange.
- Session keys come from both exchanges (ephemeral and static), so the
  session is bound to the pinned identity, not just to whoever answered.
- Frames are `8-byte big-endian counter || AES-256-GCM ciphertext`. The
  counter is the nonce tail and the AAD; a receiver accepts only the exact
  next counter. Hello replays are refused through markers in the secret
  store.
- Large-frame splitting wraps outside the encrypted socket: plaintext is
  split first, then each frame is encrypted.

Everything on /ws rides this channel, including the `terminal.*` methods.
Mobile clients do not opt in yet — Hermes has no SubtleCrypto — and keep
using the plain socket.

## The /mcp endpoint

/mcp is Streamable HTTP, and the MCP specification has no encryption
negotiation, so there is no way to require E2EE without breaking standard
clients (Claude Code, Claude Desktop, and friends). They keep working
unchanged, behind bearer auth and whatever transport encryption the
deployment already has (HTTPS, Tailscale).

S8 Code's own clients — `mcpToolSession` (the ACP bridge and the
`t3 thread` CLI) and `PeerMcpClient` for linked environments — opt in:

- The handshake rides headers instead of frames: a POST with an
  `x-s8-e2ee-hello` header gets `x-s8-e2ee-accept` and an
  `x-s8-e2ee-key-id` naming the session keys.
- Each JSON-RPC message then travels as an envelope
  (`{t: "e2ee", v: 1, c, ct}`) under the same key derivation and counter
  rules as /ws. A response the transport would stream as SSE is delivered
  as an ordered array of envelope messages.
- A session that was keyed refuses plaintext bodies outright.
- Key pairing answers carry the server fingerprint, so a client that
  paired with an allowlist key can pin the identity without a descriptor.

## Device hub streams

The three proxied device WebSockets (`/api/devices/ws`, the serve-sim
helper, and the serve-emu socket) carry binary frames, so they use a
binary variant of the socket wrapper: after the same hello/accept
handshake, binary payloads are encrypted as counter-prefixed AEAD frames
instead of being passed through. Only the client-to-proxy leg is covered;
the proxy-to-hub leg is a loopback connection to a separate local process
and is left alone. Opt-in is the same `e2ee=1` query parameter.

## Not covered

- Voice (`/ws/voice`): a separate real-time path; the latency and framing
  costs were not worth it.
- Pairing and OAuth HTTP flows: short-lived, single-use codes with replay
  markers already; the browser redirect mechanics do not fit this layer.
- Attachments and asset URLs: access is by signed URL, which is an
  at-rest authorization design, not a transport one.
- Preview tunnel: raw TCP whose inner traffic already runs its own TLS;
  encrypting inside would break the pages it carries.
- Preview stream and guest share: left for later (preview stream) or not
  applicable (guest share runs in an outside browser with no key to pin).

## Where the code lives

- Contract: `packages/contracts/src/e2ee.ts`
- Server handshake, keys, and sockets: `apps/server/src/e2ee/`
- /mcp middleware: `apps/server/src/mcp/mcpE2ee.ts`; client fetch:
  `apps/server/src/e2ee/e2eeFetch.ts`
- Web/desktop client: `packages/client-runtime/src/connection/e2ee/`,
  with `deviceSocket.ts` for the binary variant
