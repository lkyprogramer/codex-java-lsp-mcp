// input: QUERY_MYBATIS_* worker requests plus the live store.
// output: true when the command was a MyBatis query and has been answered.
// pos: Command-domain split of java-index-worker.ts MyBatis handlers.
import type { JavaIndexRequest, JavaIndexResponse } from "./worker-protocol.js";
import type { JavaIndexStore } from "./index-store.js";

export async function handleMybatisCommand(
  request: JavaIndexRequest,
  deps: { store?: JavaIndexStore; respond(response: JavaIndexResponse): void }
): Promise<boolean> {
  switch (request.type) {
    case "QUERY_MYBATIS_RESOURCE": {
      deps.respond({ id: request.id, ok: true, value: deps.store?.myBatisResource(request.relativePath) });
      return true;
    }
    case "QUERY_MYBATIS_RESOURCES_BY_NAMESPACE": {
      deps.respond({
        id: request.id,
        ok: true,
        value: request.namespaces.map(namespace => {
          const resource = deps.store?.myBatisResourceForNamespace(namespace);
          return resource ? { namespace, resource } : { namespace };
        })
      });
      return true;
    }
    case "QUERY_REPOSITORY_FACT_MARKERS": {
      deps.respond({
        id: request.id,
        ok: true,
        value: deps.store?.repositoryFactMarkers(request.importPrefixes, request.annotationPrefixes)
          ?? { importPrefixFound: false, annotationPrefixFound: false }
      });
      return true;
    }
    default:
      return false;
  }
}
