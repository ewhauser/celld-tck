import { Effect } from "effect";
import { operation, platform, rejection } from "./Platform.js";
export const web = (request: Request) =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/web/cache": {
        const key = new Request(
          "https://cache.test/" + new URL(request.url).searchParams.get("name"),
        );
        yield* platform(() =>
          caches.default.put(
            key,
            new Response("cached", {
              headers: { "cache-control": "public, max-age=60" },
            }),
          ),
        );
        const cached = yield* platform(() => caches.default.match(key));
        return {
          value: cached ? yield* platform(() => cached.text()) : null,
          deleted: yield* platform(() => caches.default.delete(key)),
        };
      }
      case "/web/body": {
        const original = new Request("https://example.test/", {
          method: "POST",
          body: "λ🌍",
        });
        const clone = original.clone();
        const before = original.bodyUsed;
        const text = yield* platform(() => original.text());
        const cloned = yield* platform(() => clone.text());
        const twice = yield* rejection(platform(() => original.text()));
        const lateClone = yield* rejection(operation(() => original.clone()));
        return {
          before,
          after: original.bodyUsed,
          text,
          cloned,
          twice,
          lateClone,
        };
      }
      case "/web/headers": {
        const headers = new Headers({ "X-Value": " first " });
        headers.append("x-value", "second");
        const joined = headers.get("X-VALUE");
        headers.set("x-value", "replacement");
        const replaced = headers.get("x-value");
        headers.delete("X-VALUE");
        return {
          joined,
          replaced,
          deleted: !headers.has("x-value"),
          invalid: yield* rejection(
            operation(() => headers.set("bad\nname", "x")),
          ),
        };
      }
      case "/web/url-form": {
        const url = new URL(
          "../a%20b?x=1&x=2#fragment",
          "https://example.test/root/path",
        );
        const form = new FormData();
        form.append("x", "first");
        form.append("x", "λ");
        form.append(
          "file",
          new File([new Uint8Array([0, 128, 255])], "bytes.bin", {
            type: "application/octet-stream",
          }),
        );
        const parsed = yield* platform(() => new Response(form).formData());
        const file = parsed.get("file");
        return {
          pathname: url.pathname,
          query: url.searchParams.getAll("x"),
          values: parsed.getAll("x"),
          file:
            file instanceof File
              ? {
                  name: file.name,
                  type: file.type,
                  bytes: [
                    ...new Uint8Array(
                      yield* platform(() => file.arrayBuffer()),
                    ),
                  ],
                }
              : null,
        };
      }
      case "/web/encoding": {
        const bytes = new TextEncoder().encode("λ🌍");
        const decoder = new TextDecoder();
        const a = decoder.decode(bytes.slice(0, 3), { stream: true });
        return {
          bytes: [...bytes],
          decoded: a + decoder.decode(bytes.slice(3)),
          base64: btoa("\x00\xff"),
          decodedBase64: [...atob("AP8=")].map((c) => c.charCodeAt(0)),
          invalid: yield* rejection(
            operation(() =>
              new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
              }).decode(new Uint8Array([255])),
            ),
          ),
        };
      }
      case "/web/fetch-abort": {
        const controller = new AbortController();
        controller.abort();
        return {
          error: yield* rejection(
            platform(() =>
              fetch("https://never-contact.invalid/", {
                signal: controller.signal,
              }),
            ),
          ),
        };
      }
      case "/web/abort": {
        const controller = new AbortController();
        let calls = 0;
        controller.signal.addEventListener("abort", () => {
          calls++;
        });
        controller.abort(new Error("test abort"));
        controller.abort();
        return {
          aborted: controller.signal.aborted,
          calls,
          reason: controller.signal.reason.message,
          thrown: yield* rejection(
            operation(() => controller.signal.throwIfAborted()),
          ),
        };
      }
      case "/web/redirect": {
        const response = Response.redirect("https://example.test/next", 307);
        return {
          status: response.status,
          location: response.headers.get("location"),
          invalid: yield* rejection(
            operation(() => Response.redirect("https://example.test", 200)),
          ),
        };
      }
      case "/web/crypto": {
        const bytes = new TextEncoder().encode("abc");
        const digest = yield* platform(() =>
          crypto.subtle.digest("SHA-256", bytes),
        );
        const key = yield* platform(() =>
          crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode("key"),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign", "verify"],
          ),
        );
        const data = new TextEncoder().encode(
          "The quick brown fox jumps over the lazy dog",
        );
        const signature = yield* platform(() =>
          crypto.subtle.sign("HMAC", key, data),
        );
        const hex = (b: ArrayBuffer) =>
          [...new Uint8Array(b)]
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
        return {
          digest: hex(digest),
          hmac: hex(signature),
          verified: yield* platform(() =>
            crypto.subtle.verify("HMAC", key, signature, data),
          ),
          rejected: yield* platform(() =>
            crypto.subtle.verify("HMAC", key, signature, bytes),
          ),
          uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            crypto.randomUUID(),
          ),
        };
      }
      case "/web/aes": {
        const key = yield* platform(() =>
          crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, [
            "encrypt",
            "decrypt",
          ]),
        );
        const algorithm = { name: "AES-GCM", iv: new Uint8Array(12) };
        const encrypted = yield* platform(() =>
          crypto.subtle.encrypt(algorithm, key, new Uint8Array(0)),
        );
        const plain = yield* platform(() =>
          crypto.subtle.decrypt(algorithm, key, encrypted),
        );
        const corrupt = new Uint8Array(encrypted.slice(0));
        corrupt[0] = corrupt[0]! ^ 1;
        return {
          ciphertext: [...new Uint8Array(encrypted)]
            .map((x) => x.toString(16).padStart(2, "0"))
            .join(""),
          plaintext: [...new Uint8Array(plain)],
          tampered: yield* rejection(
            platform(() => crypto.subtle.decrypt(algorithm, key, corrupt)),
          ),
        };
      }
      case "/web/html": {
        const response = new HTMLRewriter()
          .on("p", {
            element(element) {
              element.setAttribute("data-test", "yes");
              element.setInnerContent("λ & text");
            },
          })
          .transform(new Response("<p>before</p>"));
        return { html: yield* platform(() => response.text()) };
      }
      case "/streams/tee": {
        const [a, b] = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([0, 128]));
            c.enqueue(new Uint8Array([255, 10]));
            c.close();
          },
        }).tee();
        return {
          a: [
            ...new Uint8Array(
              yield* platform(() => new Response(a).arrayBuffer()),
            ),
          ],
          b: [
            ...new Uint8Array(
              yield* platform(() => new Response(b).arrayBuffer()),
            ),
          ],
        };
      }
      case "/streams/cancel": {
        let reason: unknown;
        let pulls = 0;
        const stream = new ReadableStream(
          {
            pull(c) {
              pulls++;
              c.enqueue("first");
            },
            cancel(value) {
              reason = value;
            },
          },
          { highWaterMark: 0 },
        );
        const reader = stream.getReader();
        const first = yield* platform(() => reader.read());
        yield* platform(() => reader.cancel("stop"));
        return {
          first,
          reason,
          pulls,
          after: yield* platform(() => reader.read()),
        };
      }
      case "/streams/error": {
        const stream = new ReadableStream({
          start(c) {
            c.error(new TypeError("broken"));
          },
        });
        return {
          error: yield* rejection(platform(() => stream.getReader().read())),
        };
      }
      case "/streams/transform": {
        const source = new ReadableStream<string>({
          start(c) {
            c.enqueue("a");
            c.enqueue("λ");
            c.close();
          },
        });
        const transformed = source.pipeThrough(
          new TransformStream<string, Uint8Array>({
            transform(chunk, c) {
              c.enqueue(new TextEncoder().encode(chunk.toUpperCase()));
            },
          }),
        );
        return {
          text: yield* platform(() => new Response(transformed).text()),
        };
      }
      case "/streams/backpressure": {
        const trace: string[] = [];
        let release: (() => void) | undefined;
        const sink = new WritableStream<string>(
          {
            write(value) {
              trace.push(value);
              return new Promise<void>((resolve) => {
                release = resolve;
              });
            },
          },
          { highWaterMark: 1 },
        );
        const writer = sink.getWriter();
        const initial = writer.desiredSize;
        const pending = writer.write("one");
        const blocked = writer.desiredSize;
        yield* platform(() => Promise.resolve());
        if (!release) throw new Error("write was not started");
        release();
        yield* platform(() => pending);
        yield* platform(() => writer.ready);
        const resumed = writer.desiredSize;
        yield* platform(() => writer.close());
        return { initial, blocked, resumed, trace };
      }
      default:
        return undefined;
    }
  });
