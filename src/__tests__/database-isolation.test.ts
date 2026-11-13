import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { getAllUsers, getUserById, seedDatabase, updateUserById } from "../../backend/database";

describe("unit database isolation", () => {
  it("seeds and mutates working data without changing the tracked database file", () => {
    const databaseFile = path.resolve(__dirname, "../../data/database.json");
    const before = fs.readFileSync(databaseFile);
    try {
      seedDatabase();
      const user = getAllUsers()[0];
      updateUserById(user.id, { firstName: "Unit memory database probe" });
      expect(getUserById(user.id).firstName).toBe("Unit memory database probe");
      expect(fs.readFileSync(databaseFile).equals(before)).toBe(true);
    } finally {
      // Restore this test's own disk write when exercising the broken adapter.
      if (!fs.readFileSync(databaseFile).equals(before)) fs.writeFileSync(databaseFile, before);
    }
  });
});
