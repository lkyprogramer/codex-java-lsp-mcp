import type { JavaMethodFacts } from "../index-types.js";
import type { TypeRegistryView } from "../name-resolver.js";
import type { SqlFactsStore } from "./facts-store.js";

const LRU_LIMIT = 2048;

export function buildSqlRegistryView(store: SqlFactsStore): TypeRegistryView {
  const nested = new Map<string, string>();
  return {
    byId: store.typesById as unknown as TypeRegistryView["byId"],
    byFqn: store.typeIdByFqn as unknown as TypeRegistryView["byFqn"],
    bySimpleName: store.typeIdsBySimpleName as unknown as TypeRegistryView["bySimpleName"],
    nestedByOwnerAndSimpleName: {
      get(key: string): string | undefined {
        const cached = nested.get(key);
        if (cached !== undefined) {
          nested.delete(key);
          nested.set(key, cached);
          return cached === "" ? undefined : cached;
        }
        const sep = key.indexOf("#");
        const id = sep < 0 ? undefined : store.nestedTypeId(key.slice(0, sep), key.slice(sep + 1));
        if (nested.size >= LRU_LIMIT) {
          const oldest = nested.keys().next().value;
          if (oldest !== undefined) nested.delete(oldest);
        }
        nested.set(key, id ?? "");
        return id;
      }
    } as TypeRegistryView["nestedByOwnerAndSimpleName"],
    methodsByOwnerTypeId: {
      get(ownerTypeId: string): readonly JavaMethodFacts[] | undefined {
        const found = store.methodsOfOwner(ownerTypeId);
        return found.length === 0 ? undefined : found;
      }
    }
  };
}
