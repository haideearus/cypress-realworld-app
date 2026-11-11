import { RequestHandler } from "express";
import { PostgresState } from "./postgres-state";

export function persistResponses(store: PostgresState): RequestHandler {
  return async (req, res, next) => {
    let transaction;
    try {
      transaction = await store.begin();
    } catch {
      res.status(503).json({ error: "Database temporarily unavailable" });
      return;
    }
    if (res.destroyed) {
      await transaction.rollback().catch(() => {});
      return;
    }
    const originalEnd = res.end;
    const originalWrite = res.write;
    const originalWriteHead = res.writeHead;
    const originalFlush = res.flushHeaders;
    const chunks: Buffer[] = [];
    let finishing = false;
    const restore = () => {
      res.end = originalEnd;
      res.write = originalWrite;
      res.writeHead = originalWriteHead;
      res.flushHeaders = originalFlush;
    };
    const onClose = () => {
      if (!finishing) {
        finishing = true;
        restore();
        void transaction.rollback().catch(() => {});
      }
    };
    res.once("close", onClose);
    res.flushHeaders = () => {};
    res.writeHead = ((code: number, ...args: any[]) => {
      res.statusCode = code;
      const headers = typeof args[0] === "string" ? args[1] : args[0];
      if (headers) {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value as any);
      }
      return res;
    }) as any;
    res.write = ((chunk: any, encoding?: any, callback?: any) => {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(
              chunk,
              typeof encoding === "string" ? (encoding as BufferEncoding) : undefined
            )
      );
      const done = typeof encoding === "function" ? encoding : callback;
      if (done) process.nextTick(done);
      return true;
    }) as any;
    res.end = ((chunk?: any, encoding?: any, callback?: any) => {
      if (finishing) return res;
      finishing = true;
      if (chunk != null && typeof chunk !== "function")
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                chunk,
                typeof encoding === "string" ? (encoding as BufferEncoding) : undefined
              )
        );
      const done =
        typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback;
      void (async () => {
        try {
          if (res.statusCode < 400) await transaction.commit();
          else await transaction.rollback();
          restore();
          originalEnd.call(res, Buffer.concat(chunks), done);
        } catch {
          restore();
          for (const name of res.getHeaderNames()) res.removeHeader(name);
          res.status(503).json({ error: "Database temporarily unavailable" });
        } finally {
          res.off("close", onClose);
        }
      })();
      return res;
    }) as any;
    next();
  };
}
