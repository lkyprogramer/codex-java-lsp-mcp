// The native launcher always preloads this module before executing an entry.
import { assertOwnerLock, ownerCacheRoot } from "./owner-lock.js";
import { readMacNativeIdentity } from "./clonefile.js";

if (!ownerCacheRoot()) throw new Error("owner launcher binding missing");
await readMacNativeIdentity();
assertOwnerLock();
