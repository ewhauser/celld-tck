// In-network security probe.
//
// Two boundary probes cannot be driven from the host through the harness
// Transport: celld's peer and operator listener is never published outside the
// Compose network, and the Host/forwarded-header and body-limit cases need
// control of the request line and of a streamed body. This module is bundled
// into the fixture directory and executed inside the sidecar container, the
// same way StorageProxy.ts is.
//
// It performs no assertions. Every observation is printed as one JSON line and
// classified by the pure oracles in SecurityOracles.ts.
import { Effect } from "effect";
// oxlint-disable-next-line effect/use-http-client-service -- The probe deliberately controls raw sockets and request lines.
import { connect } from "node:net";

export interface HttpProbe {
  readonly kind: "http";
  readonly label: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** A declared body of this many filler bytes, generated here rather than carried in argv. */
  readonly bodyBytes?: number;
  /** A declared, well-formed fixture write whose total length is exact. */
  readonly bodyJson?: {
    readonly id: string;
    readonly payloadBytes: number;
  };
  /** Sends a chunked body of `count` frames of `bytes` each, without a declared length. */
  readonly chunks?: { readonly bytes: number; readonly count: number };
  readonly timeoutMs?: number;
}
export interface RawProbe {
  readonly kind: "raw";
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** Written verbatim, so malformed and noncanonical values reach celld intact. */
  readonly hostHeader: string;
  readonly timeoutMs?: number;
}
export type Probe = HttpProbe | RawProbe;
export interface ProbeResult {
  readonly label: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly error?: string;
}

const clamp = (value: string) => value.slice(0, 4096);

const httpProbe = (probe: HttpProbe) =>
  Effect.tryPromise({
    try: async (): Promise<ProbeResult> => {
      const stream = probe.chunks;
      const body = stream
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < stream.count; index++)
                controller.enqueue(new Uint8Array(stream.bytes).fill(120));
              controller.close();
            },
          })
        : probe.bodyBytes !== undefined
          ? "x".repeat(probe.bodyBytes)
          : probe.bodyJson
            ? JSON.stringify({
                id: probe.bodyJson.id,
                payload: "x".repeat(probe.bodyJson.payloadBytes),
              })
            : probe.body;
      // oxlint-disable-next-line effect/use-http-client-service -- Runs inside the sidecar container, outside the harness runtime.
      const response = await fetch(probe.url, {
        method: probe.method ?? "GET",
        ...(probe.headers ? { headers: probe.headers } : {}),
        ...(body === undefined ? {} : { body, duplex: "half" }),
        signal: AbortSignal.timeout(probe.timeoutMs ?? 20000),
      } as RequestInit);
      return {
        label: probe.label,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: clamp(await response.text()),
      };
    },
    catch: (error): ProbeResult => ({
      label: probe.label,
      error: String(error),
    }),
  }).pipe(Effect.catch(Effect.succeed));

export const parseRaw = (label: string, wire: string): ProbeResult => {
  const separator = wire.indexOf("\r\n\r\n");
  if (separator === -1) return { label, error: `truncated response: ${wire}` };
  const head = wire.slice(0, separator).split("\r\n");
  const status = Number(head[0]?.split(" ")[1]);
  if (!Number.isInteger(status))
    return { label, error: `unparsable status line: ${head[0]}` };
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
  }
  return { label, status, headers, body: clamp(wire.slice(separator + 4)) };
};

const rawProbe = (probe: RawProbe) =>
  Effect.callback<ProbeResult>((resume) => {
    let settled = false;
    let wire = "";
    const socket = connect(probe.port, probe.host, () => {
      socket.write(
        `GET ${probe.path} HTTP/1.1\r\nHost: ${probe.hostHeader}\r\nconnection: close\r\n\r\n`,
      );
    });
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(result));
    };
    socket.setTimeout(probe.timeoutMs ?? 20000, () =>
      settle({ label: probe.label, error: "timeout" }),
    );
    socket.on("data", (chunk) => {
      wire += String(chunk);
    });
    socket.on("error", (error) =>
      settle({ label: probe.label, error: String(error) }),
    );
    socket.on("close", () => settle(parseRaw(probe.label, wire)));
    return Effect.sync(() => socket.destroy());
  });

export const runProbes = (probes: readonly Probe[]) =>
  // Sequential on purpose: several probes observe the same node's state.
  Effect.forEach(probes, (probe) =>
    probe.kind === "raw" ? rawProbe(probe) : httpProbe(probe),
  );

const specification = process.argv[2];
if (specification)
  // oxlint-disable-next-line effect/effect-run-in-body -- Standalone probe entrypoint.
  Effect.runFork(
    runProbes(JSON.parse(specification) as readonly Probe[]).pipe(
      Effect.flatMap((results) =>
        Effect.sync(() => {
          for (const result of results) console.log(JSON.stringify(result));
        }),
      ),
    ),
  );
