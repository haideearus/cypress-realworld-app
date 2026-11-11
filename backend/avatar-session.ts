import { RequestHandler } from "express";
import passport from "passport";
import { PostgresState } from "./postgres-state";

// Resolve and copy identity under a short state lease. Receiving upload bytes,
// signing downloads, and remote storage calls must not hold the global row lock.
export function avatarSession(state: PostgresState): RequestHandler {
  return async (req, res, next) => {
    let transaction;
    try {
      transaction = await state.begin();
      if (res.destroyed) {
        await transaction.rollback();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        passport.session()(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
      });
      if (req.user) req.user = { ...req.user };
      await transaction.commit();
      if (!res.destroyed) next();
    } catch {
      await transaction?.rollback().catch(() => {});
      if (!res.destroyed) res.status(503).json({ error: "Database temporarily unavailable" });
    }
  };
}
