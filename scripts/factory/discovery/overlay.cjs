// Runs only under uid1000 in a fresh /work/app copy. Never modifies the image.
const fs = require("node:fs"),
  path = require("node:path");
function applyOverlay(root, files) {
  if (!Array.isArray(files) || files.length > 50) throw Error("Invalid runtime overlay");
  const top = fs.lstatSync(root);
  if (!top.isDirectory() || top.isSymbolicLink()) throw Error("Unsafe overlay root");
  let total = 0;
  for (const file of files) {
    const name = file.path;
    if (
      typeof name !== "string" ||
      name.length > 240 ||
      /[\\\0\r\n]/.test(name) ||
      name
        .split("/")
        .some((x) => !x || x === ".." || x.startsWith(".") || /^(?:agents|claude)\.md$/i.test(x)) ||
      !(
        /^(?:src\/|backend\/|cypress\/tests\/|scripts\/tests\/)/.test(name) || name === "README.md"
      ) ||
      /^scripts\/tests\/factory-/i.test(name)
    )
      throw Error("Forbidden runtime overlay path");
    const parts = name.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent);
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe overlay parent");
    }
    const target = path.join(parent, parts.at(-1));
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Unsafe overlay target");
    }
    if (file.deleted === true) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      continue;
    }
    if (
      file.mode !== "100644" ||
      typeof file.content !== "string" ||
      /\0|\uFFFD/.test(file.content)
    )
      throw Error("Invalid overlay content");
    const size = Buffer.byteLength(file.content);
    total += size;
    if (size > 200000 || total > 500000) throw Error("Overlay size exceeded");
    fs.writeFileSync(target, file.content, { mode: 0o644 });
  }
}
module.exports = { applyOverlay };
