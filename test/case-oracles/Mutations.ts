import { gzipSync, deflateSync } from "node:zlib";

// Each mutation models a specific broken behavior promised by the case. Do not
// generate these from expected results or substitute generic malformed envelopes.
export interface Change {
  readonly path: readonly (string | number)[];
  readonly value: unknown;
}
export interface Mutation {
  readonly name: string;
  readonly changes: readonly [Change, ...Change[]];
}
const change = (path: Change["path"], value: unknown): Change => ({
  path,
  value,
});
const mutate = (name: string, ...changes: [Change, ...Change[]]): Mutation => ({
  name,
  changes,
});
const body = (name: string, field: string, value: unknown) =>
  mutate(name, change(["body", field], value));
export const mutations = {
  "http.request-response": [
    body("POST is incorrectly forwarded as GET", "method", "GET"),
    body("duplicate query parameters are collapsed", "query", ["second"]),
    body("UTF-8 request body is corrupted", "body", "hello ? ?\n"),
  ],
  "storage.round-trip": [
    mutate("stored value is lost", change([3, "body"], { present: false })),
    mutate(
      "another object can read the stored value",
      change([5, "body"], { present: true, value: "leaked" }),
    ),
    mutate(
      "deleted key remains readable",
      change([7, "body"], { present: true, value: "stale" }),
    ),
    mutate(
      "listing reverses key order",
      change([4, "body", 0, 0], "item:b"),
      change([4, "body", 1, 0], "item:a"),
    ),
  ],
  "storage.transaction-rollback": [
    mutate(
      "rollback retains the modified balance",
      change([2, "body", "value"], 99),
    ),
    mutate(
      "rollback retains a newly inserted key",
      change([3, "body"], { present: true, value: "uncommitted" }),
    ),
  ],
  "sql.transaction-rollback": [
    mutate(
      "rollback leaks an uncommitted SQL row",
      change(
        [2, "body"],
        [
          { id: 1, value: "committed" },
          { id: 2, value: "uncommitted" },
        ],
      ),
    ),
  ],
  "http.fetch-abort": [
    body("aborted fetch resolves instead of rejecting", "error", "accepted"),
  ],
  "storage.synchronous-kv": [
    body("synchronous get returns a stale value", "a", { value: 0 }),
    body("reverse listing is returned forwards", "list", [
      ["a", { value: 1 }],
      ["b", "λ"],
    ]),
    body("deleted key remains present", "missing", false),
  ],
  "sql.mixed-rollback": [
    body("SQL rollback leaves KV writes committed", "balance", 2),
    body("KV rollback leaves SQL writes committed", "rows", [{ n: 2 }]),
  ],
  "context.wait-until": [
    body("background write is never completed", "value", "pending"),
  ],
  "cache.documented-miss": [
    body("cache put is lost on the conforming runtime", "value", null),
    body("cached entry cannot be deleted", "deleted", false),
  ],
  "http.body-consumption": [
    body("a consumed body can be read twice", "twice", "accepted"),
    body("a consumed body can be cloned", "lateClone", "accepted"),
    body("consumption does not set bodyUsed", "after", false),
  ],
  "http.headers": [
    body("append replaces the existing value", "joined", "second"),
    body("delete leaves the header in place", "deleted", false),
    body("invalid header name is accepted", "invalid", "accepted"),
  ],
  "http.url-formdata": [
    body("repeated form fields lose their first value", "values", ["λ"]),
    mutate(
      "file bytes are corrupted",
      change(["body", "file", "bytes"], [0, 127, 255]),
    ),
    body("duplicate URL parameters lose ordering", "query", ["2", "1"]),
  ],
  "http.encoding": [
    body("UTF-8 decoder replaces valid non-ASCII text", "decoded", "��"),
    body("base64 decoding truncates a high byte", "decodedBase64", [0, 127]),
    body("invalid encoded input is accepted", "invalid", "accepted"),
  ],
  "http.abort": [
    body("abort listener is never invoked", "calls", 0),
    body("throwIfAborted does not throw", "thrown", "accepted"),
    body("abort reason is discarded", "reason", null),
  ],
  "http.redirect": [
    body("redirect changes its method-preserving status", "status", 302),
    body(
      "redirect loses its destination",
      "location",
      "https://example.test/wrong",
    ),
    body("invalid redirect status is accepted", "invalid", "accepted"),
  ],
  "crypto.sha256-hmac": [
    body("SHA-256 digest is incorrect", "digest", "00".repeat(32)),
    body("HMAC digest is incorrect", "hmac", "00".repeat(32)),
    body("invalid signature is accepted", "rejected", true),
    body("valid signature is rejected", "verified", false),
  ],
  "crypto.aes-gcm": [
    body(
      "authenticated encryption returns the wrong ciphertext",
      "ciphertext",
      "00".repeat(16),
    ),
    body("tampered ciphertext decrypts without error", "tampered", "accepted"),
  ],
  "web.html-rewriter": [
    body(
      "element handler fails to add its attribute",
      "html",
      "<p>λ &amp; text</p>",
    ),
  ],
  "storage.rich-values": [
    mutate(
      "bigint loses integer precision",
      change(["body", "value", 0, 1, "value"], "9007199254740992"),
    ),
    mutate(
      "typed array loses its type",
      change(["body", "value", 2, 1, "type"], "Array"),
    ),
    mutate(
      "negative zero becomes positive zero",
      change(["body", "value", 8, 1, "value"], 0),
    ),
  ],
  "storage.batch-ranges": [
    body("exclusive range end is incorrectly included", "forward", [
      ["k:b", 2],
      ["k:c", 3],
    ]),
    body("reverse range returns ascending keys", "reverse", [
      ["k:b", 2],
      ["k:c", 3],
    ]),
    body("delete count includes missing keys", "deleted", 3),
  ],
  "storage.delete-all": [
    body("deleteAll retains a key", "values", [["leftover", 1]]),
    body("deleteAll retains an alarm", "alarm", 123),
  ],
  "storage.transaction-commit": [
    body("commit drops one of its writes", "entries", [["a", 7]]),
    body("transaction callback result is discarded", "result", null),
  ],
  "storage.explicit-rollback": [
    body("explicit rollback commits the new value", "value", 2),
  ],
  "storage.invalid-input": [
    body("negative limit throws the wrong error class", "limit", "Error"),
    body(
      "uncloneable value throws the wrong error class",
      "unserializable",
      "TypeError",
    ),
  ],
  "sql.bindings-cursors": [
    mutate(
      "SQL blob loses its high byte",
      change(["body", "inserted", 0, "bytes", "value"], [0, 127, 255]),
    ),
    body("raw cursor reorders columns", "raw", [["λ'", 1, null]]),
    mutate(
      "bound SQL text is truncated at the quote",
      change(["body", "inserted", 0, "text"], "λ"),
    ),
  ],
  "sql.constraints": [
    body("duplicate primary key is accepted", "duplicate", false),
    body("NOT NULL constraint is not enforced", "nil", false),
    body("failed insert changes committed rows", "rows", [
      { id: 1, v: "overwritten" },
    ]),
  ],
  "sql.transaction-commit": [
    body("committed SQL update is lost", "row", { n: 1 }),
    body("SQL transaction return value is lost", "returned", null),
  ],
  "identity.namespace": [
    body("distinct names resolve to the same object", "different", false),
    body("unique IDs collide", "unique", false),
    body("invalid ID text is accepted", "invalid", "accepted"),
  ],
  "concurrency.input-gates": [
    mutate(
      "two requests read the same pre-increment value",
      change([1, "body", "before"], 0),
      change([1, "body", "after"], 1),
    ),
    mutate("one increment is lost", change([0, "body", "after"], 0)),
    mutate(
      "request observes uninitialized state",
      change([0, "body", "initialized"], false),
    ),
  ],
  "concurrency.explicit-gate": [
    mutate(
      "two gated requests occupy the same transition",
      change([0, "body", "before"], 10),
      change([0, "body", "after"], 11),
    ),
    mutate("gated increment skips a value", change([0, "body", "after"], 3)),
    mutate(
      "request enters before initialization completes",
      change([0, "body", "initialized"], false),
    ),
  ],
  "rpc.structured-clone": [
    mutate(
      "RPC bigint is rounded",
      change(["body", "value", 0, 1, "value"], "9007199254740992"),
    ),
    mutate(
      "RPC Map becomes an ordinary object",
      change(["body", "value", 4, 1, "type"], "Object"),
    ),
  ],
  "rpc.thrown-error": [
    body("RPC loses the thrown error class", "error", "Error"),
  ],
  "rpc.returned-target": [
    body("returned RPC target drops an argument", "sum", 40),
  ],
  "alarms.set-replace-delete": [
    body("alarm replacement keeps the old deadline", "replaced", false),
    body("deleted alarm retains its deadline", "deleted", 123),
  ],
  "alarms.fire": [
    body("scheduled alarm never fires", "fires", 0),
    body("successful alarm fires twice", "fires", 2),
  ],
  "alarms.retry": [
    body("failed alarm is never retried", "fires", 1),
    body("retry metadata does not advance", "retryCount", 0),
  ],
  "streams.tee": [
    body("tee loses bytes on its second branch", "b", [0, 128, 10]),
  ],
  "streams.cancel": [
    body("cancellation reason does not reach the source", "reason", null),
    body("cancelled reader continues yielding chunks", "after", {
      done: false,
      value: "extra",
    }),
  ],
  "streams.error": [
    body("stream source failure is swallowed", "error", "accepted"),
  ],
  "streams.transform": [
    body("transform passes through unmodified input", "text", "aλ"),
  ],
  "streams.backpressure": [
    body("writer proceeds while the queue is full", "blocked", 1),
    body("writer never resumes after the queue drains", "resumed", 0),
  ],
  "streams.http-binary": [
    mutate(
      "streamed binary response drops its high byte",
      change(["body"], [0, 1, 128, 10]),
    ),
  ],
  "websocket.protocol-attachment": [
    mutate(
      "binary websocket frame becomes text",
      change([2, "value"], "0,128,255"),
    ),
    mutate(
      "serialized attachment loses its counter",
      change([3, "value"], '{"label":"durable","count":0}'),
    ),
    mutate(
      "websocket closes abnormally",
      change([4, "code"], 1006),
      change([4, "clean"], false),
    ),
  ],
  "workflows.retry": [
    mutate(
      "workflow step succeeds without its required retry",
      change(["body", "output", "attempts"], 1),
    ),
  ],
  "workflows.event": [
    mutate(
      "workflow event payload is lost",
      change(["body", "output", "payload", "value"], ""),
    ),
  ],
  "rpc.named-service": [
    body(
      "named service receives the wrong argument",
      "greeting",
      "hello undefined",
    ),
  ],
  "kv.metadata-list": [
    mutate("KV metadata is lost", change(["body", "value", "metadata"], null)),
    body("deleted KV key remains readable", "missing", "stale"),
    body("KV prefix listing includes another prefix", "names", [
      "/a",
      "other/b",
    ]),
  ],
  "kv.binary-pagination": [
    body("pagination repeats the first page", "second", ["/a"]),
    body("binary KV value loses its high byte", "bytes", [0, 127, 255]),
  ],
  "d1.bindings-results": [
    mutate("D1 binds the wrong integer", change(["body", "first", "n"], 0)),
    body("D1 raw results lose column order", "raw", [["λ'", 7]]),
  ],
  "d1.batch-rollback": [
    body("failed D1 batch commits its first statement", "value", 2),
  ],
  "r2.metadata-range-delete": [
    body("R2 range includes the wrong bytes", "range", [0, 128]),
    body("R2 custom metadata is lost", "metadata", {}),
    body("deleted R2 object remains readable", "missing", { size: 4 }),
  ],
  "r2.conditional-write": [
    body("mismatched ETag is allowed to overwrite", "rejected", false),
    body("matching ETag write does not persist", "value", "first"),
  ],
  "r2.multipart": [
    body("multipart completion loses its final part", "value", ""),
    body("aborted multipart upload leaves an object", "aborted", { size: 17 }),
  ],
  "queues.batch-ack-retry": [
    mutate(
      "retry request never produces redelivery",
      change(["body", "single", "attempts"], 1),
    ),
    mutate(
      "acknowledged batch message is delivered twice",
      change(["body", "batch-a", "attempts"], 2),
    ),
  ],
  "workflows.steps-sleep-result": [
    mutate(
      "workflow loses the persisted step result",
      change(["body", "output", "result"], 0),
    ),
  ],
  "node.buffer": [
    body("Buffer encoding truncates non-ASCII bytes", "hex", "3f3f"),
    body("Buffer slice uses the wrong bounds", "slice", [187, 240]),
  ],
  "node.path-events": [
    body("once listener fires more than once", "trace", [
      "once:a",
      "on:a",
      "once:b",
      "on:b",
    ]),
    body(
      "path normalization fails to resolve parent segments",
      "path",
      "/a/../b/c",
    ),
    body("removed listeners remain registered", "remaining", 1),
  ],
  "node.async-context": [
    body("async-local state escapes its scope", "outsideMissing", false),
  ],
  "node.hash-compression": [
    body(
      "valid gzip stream contains the wrong plaintext",
      "gzipBytes",
      gzipSync("wrong λ").toString("base64"),
    ),
    body(
      "valid deflate stream contains the wrong plaintext",
      "deflateBytes",
      deflateSync("wrong λ").toString("base64"),
    ),
    body("gzip encoder is an identity function", "gzipBytes", "aGVsbG8gzrs="),
    body(
      "deflate encoder is an identity function",
      "deflateBytes",
      "aGVsbG8gzrs=",
    ),
    body("gzip decoder returns compressed input", "gzip", "aGVsbG8gzrs="),
    body("deflate decoder drops UTF-8 text", "deflate", "hello ?"),
  ],
  "wasm.module": [
    body(
      "WebAssembly addition does not wrap i32 overflow",
      "overflow",
      2147483648,
    ),
    body(
      "WebAssembly treats signed operands as unsigned",
      "negative",
      4294967291,
    ),
  ],
  "assets.binding": [
    body(
      "asset binding returns fallback content for a missing file",
      "missing",
      200,
    ),
    body("asset binding loses file contents", "text", ""),
  ],
  "dynamic.fetch": [
    body("dynamic worker is not invoked", "text", "static fallback"),
  ],
  "facets.isolation": [
    body("one facet's counter leaks into a different facet", "c", { n: 3 }),
  ],
  "repro.body-readers": [
    mutate(
      "Request text reader accepts repeat consumption",
      change(["body", 0, "second"], { outcome: "fulfilled" }),
    ),
    mutate(
      "Response formData reader accepts repeat consumption",
      change(["body", 10, "second"], { outcome: "fulfilled" }),
    ),
    mutate(
      "null Request body is incorrectly marked used",
      change(["body", 5, "used"], true),
    ),
    mutate(
      "null Response body is incorrectly marked used",
      change(["body", 11, "used"], true),
    ),
  ],
  "repro.storage-errors": [
    mutate(
      "async storage accepts a negative list limit",
      change(["body", "asyncLimit", "outcome"], "fulfilled"),
    ),
    mutate(
      "sync storage throws the wrong list error",
      change(["body", "syncLimit", "name"], "Error"),
    ),
    mutate(
      "clone error loses DOMException identity",
      change(["body", "asyncPut", "domException"], false),
    ),
    body("failed batch stores a partial result", "absent", false),
  ],
} satisfies Record<string, readonly [Mutation, ...Mutation[]]>;

export const divergenceMutations = {
  "cache.documented-miss": [
    body("always-miss cache invents a hit", "value", "invented"),
  ],
  "rpc.returned-target": [
    mutate(
      "unrelated RPC failure is incorrectly waived",
      change(["body", "error", "message"], "network unavailable"),
    ),
  ],
} satisfies Record<string, readonly [Mutation, ...Mutation[]]>;
