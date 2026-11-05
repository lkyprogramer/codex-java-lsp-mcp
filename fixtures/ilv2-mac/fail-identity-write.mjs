// Scoped fault injection for the runner's first identity evidence write.
import promises from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const original = promises.writeFile;
promises.writeFile = async (file, ...args) => {
  if (path.basename(String(file)) === "identity.json") {
    const error = new Error("injected identity write failure"); error.code = "ENOSPC"; throw error;
  }
  return original(file, ...args);
};
syncBuiltinESMExports();
