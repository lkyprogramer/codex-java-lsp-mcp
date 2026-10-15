import type { JavaMethodFacts } from "../index-types.js";
import type { TypeRegistryView } from "../name-resolver.js";
import { splitOwnerMemberKey } from "../stable-id.js";
import { BoundedCache } from "./bounded-cache.js";
import type { SqlFactsStore } from "./facts-store.js";

const LRU_LIMIT = 2048;

export function buildSqlRegistryView(store: SqlFactsStore): TypeRegistryView {
  const nested = new BoundedCache<string, string>(LRU_LIMIT);
  return {
    byId: store.typesById as unknown as TypeRegistryView["byId"],
    byFqn: store.typeIdsByFqn,
    locationOf: typeId => store.declarationLocation(typeId),
    bySimpleName: store.typeIdsBySimpleName as unknown as TypeRegistryView["bySimpleName"],
    nestedByOwnerAndSimpleName: {
      get(key: string): string | undefined {
        const cached = nested.get(key);
        if (cached !== undefined) return cached === "" ? undefined : cached;
        const split = splitOwnerMemberKey(key);
        const id = split === undefined ? undefined : store.nestedTypeId(split.owner, split.member);
        nested.set(key, id ?? "");
        return id;
      }
    } as TypeRegistryView["nestedByOwnerAndSimpleName"],
    methodsByOwnerTypeId: {
      get(ownerTypeId: string, name?: string): readonly JavaMethodFacts[] | undefined {
        const found = name === undefined ? store.methodsOfOwner(ownerTypeId) : store.methodsNamed(ownerTypeId, name);
        return found.length === 0 ? undefined : found;
      }
    }
  };
}
