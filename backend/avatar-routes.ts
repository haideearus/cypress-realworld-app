import express from "express";
import { randomUUID } from "crypto";
import { ensureAuthenticated } from "./helpers";
import { createAvatarStorage } from "./avatar-storage";

function imageExtension(bytes: Buffer, type: string) {
  if (
    type === "image/png" &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (type === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    return "jpg";
  if (
    type === "image/webp" &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return undefined;
}

export function avatarRoutes(origin: string) {
  const router = express.Router();
  const storage = createAvatarStorage();
  router.use(ensureAuthenticated);
  router.post(
    "/",
    express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
    async (req, res) => {
      const bytes = req.body;
      const type = req.get("content-type")?.split(";")[0] || "";
      const extension = Buffer.isBuffer(bytes) ? imageExtension(bytes, type) : undefined;
      if (!extension) {
        res.status(400).json({ error: "Choose a PNG, JPEG, or WebP image" });
        return;
      }
      if (!storage) {
        res.status(503).json({ error: "Picture storage is not configured" });
        return;
      }
      // Capture identity before remote I/O. This handler never mutates database state.
      const userId = req.user!.id;
      const object = `${randomUUID()}.${extension}`;
      try {
        await storage.upload(`avatars/${userId}/${object}`, bytes, type);
        res.status(201).json({ avatar: `${origin}/avatars/${userId}/${object}` });
      } catch {
        res.status(503).json({ error: "Picture storage is temporarily unavailable" });
      }
    }
  );
  router.get("/:userId/:object", async (req, res) => {
    const { userId, object } = req.params;
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(userId) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$/.test(object)
    ) {
      res.sendStatus(404);
      return;
    }
    if (!storage) {
      res.status(503).json({ error: "Picture storage is not configured" });
      return;
    }
    try {
      const url = await storage.url(`avatars/${userId}/${object}`);
      res.setHeader("Cache-Control", "private, no-store");
      res.redirect(url);
    } catch {
      res.status(503).json({ error: "Picture storage is temporarily unavailable" });
    }
  });
  router.use(((error: any, _req: any, res: any, next: any) => {
    if (error.type === "entity.too.large")
      res.status(413).json({ error: "Picture must be 2 MB or smaller" });
    else next(error);
  }) as express.ErrorRequestHandler);
  return router;
}
