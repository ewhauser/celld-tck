import { Console, Effect, FileSystem, Schema } from "effect";
import { Artifacts, decodeJson } from "./Artifacts.js";
import { Transport, TckError } from "./Domain.js";
import {
  checkHistory,
  checkHistoryKv,
  HistoryKv,
  HistoryRow,
  LedgerEvent,
} from "./History.js";
import { equal } from "./Oracle.js";
// Read-only recovery of the driver's audit after its process was interrupted.
export const auditLedger = (options: {
  ledger: string;
  endpoint: string;
  name: string;
}) =>
  Effect.gen(function* () {
    if (!options.ledger || !options.endpoint || !options.name)
      return yield* Effect.fail(
        new TckError({
          phase: "arguments",
          message:
            "Audit requires --ledger, --endpoint and --name; use the recorded dedicated test target",
        }),
      );
    const fs = yield* FileSystem.FileSystem;
    const transport = yield* Transport;
    const artifacts = yield* Artifacts;
    const text = yield* fs.readFileString(options.ledger);
    yield* equal(text.endsWith("\n"), true);
    const ledger = yield* Effect.forEach(
      text.split("\n").filter(Boolean),
      (line) => decodeJson(LedgerEvent, line),
    );
    const target = { name: "audit", baseUrl: options.endpoint };
    const rows: Array<typeof HistoryRow.Type> = [];
    for (let page = 0; page < 100; page++) {
      const response = yield* transport.request(target, {
        path: `/history/state?name=${encodeURIComponent(options.name)}&after=${rows.at(-1)?.seq ?? 0}`,
      });
      yield* equal(response.status, 200);
      const next = yield* Schema.decodeUnknownEffect(Schema.Array(HistoryRow))(
        response.body,
      );
      rows.push(...next);
      if (next.length < 128) {
        const summary = yield* checkHistory(ledger, rows);
        const kvResponse = yield* transport.request(target, {
          path: `/history/kv?name=${encodeURIComponent(options.name)}`,
        });
        yield* equal(kvResponse.status, 200);
        const kv = yield* Schema.decodeUnknownEffect(HistoryKv)(
          kvResponse.body,
        );
        yield* checkHistoryKv(rows, kv);
        yield* artifacts.json("ledger-audit.json", {
          ...options,
          summary,
          rows,
          kv,
        });
        yield* Console.log(JSON.stringify(summary));
        return;
      }
    }
    return yield* Effect.fail(
      new TckError({ phase: "audit", message: "History exceeded audit bound" }),
    );
  });
