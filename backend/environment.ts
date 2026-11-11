import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse } from "dotenv";

export function loadEnvironment(directory = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const file = join(directory, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parse(readFileSync(file)))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnvironment();
